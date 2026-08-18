#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const { parseSourceMap } = require('./settlement-source-manifest');
const { parseUidMap, verifyUidMap } = require('./settlement-uid-map');
const { buildSettlementPlan } = require('./settlement-plan');
const {
  assertPlanMatchesCapture,
  verifyCapturedSourceDirectory,
} = require('./settlement-source-capture');
const {
  applySettlementRefresh,
  assertRefreshBaselineInfrastructure,
  assertSettlementRefreshInfrastructure,
  classifySettlementRefresh,
  loadSettlementRefreshState,
} = require('./settlement-refresh-database');

const APPLY_CONFIRMATION = 'APPLY_CURRENT_SETTLEMENT_REFRESH';
const MAX_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_REPORT_AGE_MS = 24 * 60 * 60 * 1000;
const EXPECTED_COUNT_ARGS = Object.freeze({
  expectIntakeInsert: 'intakeInsert',
  expectMonthlyInsert: 'monthlyInsert',
  expectIntakeUpdate: 'intakeUpdate',
  expectMonthlyUpdate: 'monthlyUpdate',
  expectMissing: 'missing',
  expectConflict: 'conflict',
});

function parseArgs(argv) {
  const args = { command: argv[0] || '' };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error('알 수 없는 인수가 있습니다.');
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('명령 인수 값이 누락되었습니다.');
    args[key] = value;
    index += 1;
  }
  return args;
}

async function readSecureText(filePath, label) {
  if (!filePath) throw new Error(`${label} 파일이 필요합니다.`);
  const resolved = path.resolve(filePath);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} 파일은 mode 600인 일반 파일이어야 합니다.`);
  }
  return fs.readFile(resolved, 'utf8');
}

async function readSecureJson(filePath, label) {
  return JSON.parse(await readSecureText(filePath, label));
}

async function writeSecureJson(filePath, value) {
  if (!filePath) throw new Error('결과 파일 경로가 필요합니다.');
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

async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function verifyBackupFile(filePath, now = Date.now()) {
  if (!filePath) throw new Error('--backup-file이 필요합니다.');
  const resolved = path.resolve(filePath);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600
      || stat.size < 1024) {
    throw new Error('백업은 mode 600인 1KB 이상 일반 파일이어야 합니다.');
  }
  const age = now - stat.mtimeMs;
  if (!Number.isFinite(age) || age < -5 * 60 * 1000 || age > MAX_BACKUP_AGE_MS) {
    throw new Error('24시간 이내 생성된 운영 DB 백업이 필요합니다.');
  }
  const sha256 = await fileSha256(resolved);
  const after = await fs.lstat(resolved);
  if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
    throw new Error('검증 중 백업 파일이 변경되었습니다.');
  }
  return { sha256, byteLength: stat.size, mtimeMs: stat.mtimeMs };
}

async function readConfigs(args) {
  const [sourceText, uidText] = await Promise.all([
    readSecureText(args.sourceMapFile, 'source map'),
    readSecureText(args.uidMapFile, 'UID map'),
  ]);
  return { documents: parseSourceMap(sourceText), uidMap: parseUidMap(uidText) };
}

async function buildCurrentPlan(args, configs, capture) {
  if (!args.sourceDir) {
    throw new Error('--source-dir은 필수이며 refresh 중 live Google 재다운로드는 금지됩니다.');
  }
  const plan = await buildSettlementPlan({
    documents: configs.documents,
    uidMap: configs.uidMap,
    sourceDir: capture.directory,
  });
  assertPlanMatchesCapture(plan, capture);
  return plan;
}

async function dryReadState(pool, plan, uidMap) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    // A dry-run is a truly READ ONLY transaction. PostgreSQL rejects even a
    // SELECT ... FOR SHARE row lock in that mode; apply performs the locked
    // verification again inside its serializable write transaction.
    await verifyUidMap(client, uidMap, { lock: false });
    const state = await loadSettlementRefreshState(client, plan);
    await client.query('ROLLBACK');
    return state;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function sourceDateBounds(plan) {
  const dates = [...plan.records.intake, ...plan.records.monthly]
    .map(row => row.date)
    .filter(Boolean)
    .sort();
  return { from: dates[0] || null, to: dates.at(-1) || null };
}

function parseExpectedCounts(args) {
  const expected = {};
  for (const [argument, countKey] of Object.entries(EXPECTED_COUNT_ARGS)) {
    const value = Number(args?.[argument]);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`--${argument.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} 기대 건수가 필요합니다.`);
    }
    expected[countKey] = value;
  }
  return expected;
}

function assertExpectedCounts(actual, expected) {
  if (!actual || Object.entries(expected || {}).some(([key, value]) => actual[key] !== value)) {
    throw new Error('현재 원본의 insert/update/delete/conflict 건수가 승인된 delta와 다릅니다.');
  }
  return true;
}

function createPinnedReport({ plan, classification, backupPin, capturePin, now = new Date() }) {
  if (!/^[0-9a-f]{64}$/.test(String(capturePin?.manifestSha256 || ''))) {
    throw new Error('검증된 source capture manifest pin이 필요합니다.');
  }
  return {
    version: 1,
    createdAt: now.toISOString(),
    manifestSha256: plan.manifestSha256,
    planSha256: plan.planSha256,
    databaseStateSha256: classification.databaseStateSha256,
    operationSha256: classification.operationSha256,
    backupSha256: backupPin.sha256,
    backupBytes: backupPin.byteLength,
    captureManifestSha256: capturePin.manifestSha256,
    sourceDates: sourceDateBounds(plan),
    counts: { ...classification.counts },
    safe: classification.safe,
  };
}

function validatePinnedReport(report, backupPin, capturePin, now = Date.now()) {
  if (!report || report.version !== 1 || report.safe !== true) {
    throw new Error('안전 검증을 통과한 최신분 dry-run 보고서가 필요합니다.');
  }
  for (const key of [
    'manifestSha256', 'planSha256', 'databaseStateSha256', 'operationSha256',
    'backupSha256', 'captureManifestSha256',
  ]) {
    if (!/^[0-9a-f]{64}$/.test(String(report[key] || ''))) {
      throw new Error('dry-run 보고서 pin 형식이 올바르지 않습니다.');
    }
  }
  const createdAt = Date.parse(report.createdAt);
  if (!Number.isFinite(createdAt) || now - createdAt < -5 * 60 * 1000
      || now - createdAt > MAX_REPORT_AGE_MS) {
    throw new Error('24시간 이내 생성된 dry-run 보고서가 필요합니다.');
  }
  if (report.backupSha256 !== backupPin.sha256
      || Number(report.backupBytes) !== backupPin.byteLength) {
    throw new Error('dry-run에 사용한 운영 DB 백업과 현재 백업이 다릅니다.');
  }
  if (report.captureManifestSha256 !== capturePin?.manifestSha256) {
    throw new Error('dry-run에 사용한 source capture manifest와 현재 capture가 다릅니다.');
  }
  return report;
}

function stdoutSummary(report, extra = {}) {
  return {
    safe: report.safe,
    counts: report.counts,
    sourceDates: report.sourceDates,
    pinsCreated: true,
    ...extra,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!['dry-run', 'apply'].includes(args.command)) {
    throw new Error('dry-run 또는 apply 명령을 사용하세요.');
  }
  const expectedCounts = parseExpectedCounts(args);
  const pool = new Pool();
  try {
    await assertRefreshBaselineInfrastructure(pool);
    // DDL and ACLs are operator-owned deployment work.  Both dry-run and
    // apply are refused until the runtime role sees the exact least-privilege
    // schema; this CLI never creates or alters database infrastructure.
    await assertSettlementRefreshInfrastructure(pool);
    const [configs, backupPin] = await Promise.all([
      readConfigs(args),
      verifyBackupFile(args.backupFile),
    ]);
    const capture = await verifyCapturedSourceDirectory(args.sourceDir, configs.documents);
    const plan = await buildCurrentPlan(args, configs, capture);

    if (args.command === 'dry-run') {
      const state = await dryReadState(pool, plan, configs.uidMap);
      const classification = classifySettlementRefresh({ plan, databaseState: state });
      assertExpectedCounts(classification.counts, expectedCounts);
      const report = createPinnedReport({ plan, classification, backupPin, capturePin: capture });
      await writeSecureJson(args.reportOut, report);
      process.stdout.write(`${JSON.stringify(stdoutSummary(report, { reportWritten: true }))}\n`);
      if (!classification.safe) process.exitCode = 2;
      return;
    }

    if (args.confirm !== APPLY_CONFIRMATION) throw new Error('최신분 반영 확인 문구가 틀렸습니다.');
    const saved = validatePinnedReport(
      await readSecureJson(args.reportIn, 'dry-run report'), backupPin, capture,
    );
    assertExpectedCounts(saved.counts, expectedCounts);
    const result = await applySettlementRefresh({
      pool,
      plan,
      uidMap: configs.uidMap,
      actor: {
        uid: process.env.PEAKOS_SETTLEMENT_ACTOR_UID,
        name: process.env.PEAKOS_SETTLEMENT_ACTOR_NAME || '',
      },
      backupPin,
      expectedPins: saved,
    });
    process.stdout.write(`${JSON.stringify({
      applied: !result.noOp,
      noOp: result.noOp,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      quarantined: result.quarantined || 0,
    })}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(() => {
    // Error messages from PG, XLSX or the private manifests can contain names,
    // document ids and row values.  Diagnostics remain in the mode-600 report
    // and DB audit; stderr is deliberately constant.
    process.stderr.write('settlement-refresh: SETTLEMENT_REFRESH_FAILED\n');
    process.exitCode = 1;
  });
}

module.exports = {
  APPLY_CONFIRMATION,
  EXPECTED_COUNT_ARGS,
  MAX_BACKUP_AGE_MS,
  MAX_REPORT_AGE_MS,
  createPinnedReport,
  assertExpectedCounts,
  main,
  parseArgs,
  parseExpectedCounts,
  sourceDateBounds,
  validatePinnedReport,
  verifyBackupFile,
};
