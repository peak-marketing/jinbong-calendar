#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const {
  parseSourceMap,
} = require('./settlement-source-manifest');
const { parseUidMap, verifyUidMap } = require('./settlement-uid-map');
const { buildSettlementPlan } = require('./settlement-plan');
const {
  ensureSettlementImportInfrastructure,
  importSettlementPlan,
  rollbackSettlementImport,
} = require('./settlement-database');

const IMPORT_CONFIRMATION = 'IMPORT_2026_06_07_08';
const ROLLBACK_CONFIRMATION = 'ROLLBACK_SETTLEMENT_IMPORT';

function parseArgs(argv) {
  const args = { command: argv[0] || '' };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`알 수 없는 인수: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} 값이 필요합니다.`);
    args[key] = value;
    index += 1;
  }
  return args;
}

async function readSecretValue({ environmentName, filePath }) {
  if (filePath) {
    const resolved = path.resolve(filePath);
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Error(`${environmentName} 설정 파일은 mode 600이어야 합니다.`);
    }
    return fs.readFile(resolved, 'utf8');
  }
  const value = process.env[environmentName];
  if (!value) throw new Error(`${environmentName} 설정이 필요합니다.`);
  return value;
}

async function writeSecureJson(filePath, value) {
  const resolved = path.resolve(filePath);
  const handle = await fs.open(resolved, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return resolved;
}

async function readSecureJson(filePath, label) {
  const resolved = path.resolve(filePath);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} 파일은 mode 600이어야 합니다.`);
  }
  return JSON.parse(await fs.readFile(resolved, 'utf8'));
}

function safeSummary(plan) {
  return {
    baselineOk: plan.report.baseline.ok,
    totals: plan.report.totals,
    employees: plan.report.documents.map(document => ({
      ownerName: document.ownerName,
      monthly: Object.fromEntries(Object.entries(document.monthly).map(([month, value]) => [month, {
        candidateRows: value.candidateRows,
        acceptedRows: value.acceptedRows,
        quarantinedRows: value.quarantinedRows,
      }])),
      special: document.special ? {
        saleAccepted: document.special.saleAccepted,
        runAccepted: document.special.runAccepted,
        quarantined: document.special.quarantined,
        parentResolved: document.special.parentResolved,
        parentOrphan: document.special.parentOrphan,
      } : null,
    })),
    exceptionRows: plan.report.quarantine,
    mismatches: plan.report.baseline.mismatches,
  };
}

async function configs(args) {
  const [sourceRaw, uidRaw] = await Promise.all([
    readSecretValue({
      environmentName: 'PEAKOS_SETTLEMENT_SOURCE_MAP_JSON',
      filePath: args.sourceMapFile,
    }),
    readSecretValue({
      environmentName: 'PEAKOS_SETTLEMENT_UID_MAP_JSON',
      filePath: args.uidMapFile,
    }),
  ]);
  return { documents: parseSourceMap(sourceRaw), uidMap: parseUidMap(uidRaw) };
}

async function verifyUsers(pool, uidMap) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await verifyUidMap(client, uidMap);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function buildPinnedPlan(args, parsedConfigs) {
  if (!args.sourceDir) throw new Error('--source-dir은 필수입니다.');
  const sourceDir = path.resolve(args.sourceDir);
  const stat = await fs.lstat(sourceDir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('--source-dir은 mode 700인 비공개 디렉터리여야 합니다.');
  }
  return buildSettlementPlan({
    documents: parsedConfigs.documents,
    uidMap: parsedConfigs.uidMap,
    sourceDir,
  });
}

function assertReportPins(plan, saved) {
  if (!saved || saved.version !== 2 || saved.manifestSha256 !== plan.manifestSha256) {
    throw new Error('dry-run 후 원본 파일·manifest가 바뀌어 apply를 중단했습니다.');
  }
  if (!/^[0-9a-f]{64}$/.test(String(saved.planSha256 || ''))
      || saved.planSha256 !== plan.planSha256) {
    throw new Error('dry-run 후 정규화 결과·파서 버전이 바뀌어 apply를 중단했습니다.');
  }
  if (saved.report?.baseline?.ok !== true || plan.report.baseline.ok !== true) {
    throw new Error('기준 건수·K/L/N 검증을 통과한 dry-run만 apply할 수 있습니다.');
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!['dry-run', 'apply', 'rollback'].includes(args.command)) {
    throw new Error('dry-run, apply, rollback 중 하나를 사용하세요.');
  }
  const pool = new Pool();
  try {
    if (args.command === 'rollback') {
      if (args.confirm !== ROLLBACK_CONFIRMATION) throw new Error('롤백 확인 문구가 틀렸습니다.');
      if (!args.rollbackIn) throw new Error('rollback에는 --rollback-in이 필수입니다.');
      const rollbackManifest = await readSecureJson(args.rollbackIn, 'rollback manifest');
      if (rollbackManifest?.version !== 2
          || !/^[0-9a-f-]{36}$/i.test(String(rollbackManifest.runId || ''))
          || !/^[0-9a-f]{64}$/.test(String(rollbackManifest.manifestSha256 || ''))
          || !/^[0-9a-f]{64}$/.test(String(rollbackManifest.planSha256 || ''))
          || !Array.isArray(rollbackManifest.items)
          || rollbackManifest.items.some(item => (
            !['peakos_intake', 'peakos_monthly'].includes(item?.table)
              || !String(item?.id || '')
              || !/^[0-9a-f]{64}$/.test(String(item?.afterFingerprint || ''))
          ))) {
        throw new Error('rollback manifest 형식이 올바르지 않습니다.');
      }
      if (args.runId && args.runId !== rollbackManifest.runId) {
        throw new Error('rollback run id와 manifest가 일치하지 않습니다.');
      }
      const result = await rollbackSettlementImport({
        pool,
        runId: rollbackManifest.runId,
        actorUid: process.env.PEAKOS_SETTLEMENT_ACTOR_UID,
        manifestSha256: rollbackManifest.manifestSha256,
        planSha256: rollbackManifest.planSha256,
        manifestItems: rollbackManifest.items,
      });
      process.stdout.write(`${JSON.stringify({ rolledBack: true, runId: result.runId, deleted: result.deleted })}\n`);
      return;
    }

    const parsedConfigs = await configs(args);
    await verifyUsers(pool, parsedConfigs.uidMap);
    const plan = await buildPinnedPlan(args, parsedConfigs);
    if (args.command === 'dry-run') {
      if (!args.reportOut) throw new Error('--report-out은 필수입니다.');
      const reportFile = await writeSecureJson(args.reportOut, {
        version: 2,
        createdAt: new Date().toISOString(),
        manifestSha256: plan.manifestSha256,
        planSha256: plan.planSha256,
        sourceSnapshot: plan.sourceSnapshot,
        report: plan.report,
      });
      if (args.quarantineOut) {
        await writeSecureJson(args.quarantineOut, {
          version: 2,
          manifestSha256: plan.manifestSha256,
          planSha256: plan.planSha256,
          rows: plan.quarantine,
        });
      }
      process.stdout.write(`${JSON.stringify({ ...safeSummary(plan), reportWritten: Boolean(reportFile) })}\n`);
      if (!plan.report.baseline.ok) process.exitCode = 2;
      return;
    }

    if (args.confirm !== IMPORT_CONFIRMATION) throw new Error('이관 확인 문구가 틀렸습니다.');
    if (!args.reportIn || !args.rollbackOut) {
      throw new Error('apply에는 --report-in과 --rollback-out이 필수입니다.');
    }
    const savedReport = await readSecureJson(args.reportIn, 'dry-run report');
    assertReportPins(plan, savedReport);
    await ensureSettlementImportInfrastructure(pool);
    const result = await importSettlementPlan({
      pool,
      plan,
      uidMap: parsedConfigs.uidMap,
      actor: {
        uid: process.env.PEAKOS_SETTLEMENT_ACTOR_UID,
        name: process.env.PEAKOS_SETTLEMENT_ACTOR_NAME || '',
      },
    });
    const rollbackFile = await writeSecureJson(args.rollbackOut, result.rollbackManifest);
    process.stdout.write(`${JSON.stringify({
      applied: true,
      runId: result.runId,
      imported: result.imported,
      skipped: result.skipped,
      quarantined: result.quarantined,
      rollbackWritten: Boolean(rollbackFile),
    })}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    // Never print config values, UIDs, e-mails, document ids, clients or payer
    // names. Errors are authored as fixed safe messages throughout this CLI.
    // Unexpected database/library errors may contain DETAIL values or paths.
    // The private report and DB audit are the diagnostic sources; stderr is
    // deliberately constant so identifiers can never leak to a terminal log.
    void error;
    process.stderr.write('settlement-import: SETTLEMENT_IMPORT_FAILED\n');
    process.exitCode = 1;
  });
}

module.exports = {
  IMPORT_CONFIRMATION,
  ROLLBACK_CONFIRMATION,
  assertReportPins,
  main,
  parseArgs,
  readSecureJson,
  readSecretValue,
  safeSummary,
  writeSecureJson,
};
