#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');
const {
  ensurePeakosPlatformSettlementInfrastructure,
  inspectLatestPlatformMonthlyAggregateRun,
  quarantinePlatformMonthlyAggregateRun,
} = require('./peakos-platform-monthly-settlement');

const APPLY_CONFIRMATION = 'QUARANTINE_PLATFORM_AGGREGATE_RUN';

function parseArgs(argv) {
  const command = String(argv[0] || '');
  const args = { command };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!/^--[a-z][a-z0-9-]*$/.test(token)) throw new Error(`알 수 없는 인수: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (seen.has(key)) throw new Error(`${token}은 한 번만 지정할 수 있습니다.`);
    const value = argv[index + 1];
    if (value === undefined || String(value).startsWith('--')) {
      throw new Error(`${token} 값이 필요합니다.`);
    }
    args[key] = value;
    seen.add(key);
    index += 1;
  }
  return args;
}

function requireArgs(args, keys) {
  for (const key of keys) {
    if (!String(args[key] || '').trim()) throw new Error(`--${key.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`)}은 필수입니다.`);
  }
}

function assertAllowedArgs(args, allowed) {
  const unexpected = Object.keys(args).filter(key => key !== 'command' && !allowed.includes(key));
  if (unexpected.length) throw new Error(`이 명령에서 허용하지 않는 인수입니다: ${unexpected.join(', ')}`);
}

async function main(argv = process.argv.slice(2), { PoolClass = Pool, stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  if (!['inspect', 'apply'].includes(args.command)) {
    throw new Error('inspect 또는 apply 명령이 필요합니다.');
  }
  const common = ['workspace', 'provider', 'month'];
  if (args.command === 'inspect') {
    assertAllowedArgs(args, common);
    requireArgs(args, common);
  } else {
    const applyOnly = [
      'runId', 'expectedLatestRunId', 'operationKey', 'reason',
      'actorUid', 'actorName', 'confirm',
    ];
    assertAllowedArgs(args, [...common, ...applyOnly]);
    requireArgs(args, [...common, ...applyOnly]);
    if (args.confirm !== APPLY_CONFIRMATION) {
      throw new Error('격리 확인 문구가 일치하지 않습니다.');
    }
  }

  const pool = new PoolClass();
  try {
    await ensurePeakosPlatformSettlementInfrastructure(pool);
    if (args.command === 'inspect') {
      const inspected = await inspectLatestPlatformMonthlyAggregateRun({
        pool,
        workspaceId: args.workspace,
        provider: args.provider,
        month: args.month,
      });
      stdout.write(`${JSON.stringify({ command: 'inspect', ...inspected })}\n`);
      return inspected;
    }
    const quarantined = await quarantinePlatformMonthlyAggregateRun({
      pool,
      workspaceId: args.workspace,
      provider: args.provider,
      month: args.month,
      runId: args.runId,
      expectedLatestRunId: args.expectedLatestRunId,
      operationKey: args.operationKey,
      reason: args.reason,
      actor: { uid: args.actorUid, name: args.actorName },
    });
    stdout.write(`${JSON.stringify({ command: 'apply', ...quarantined })}\n`);
    return quarantined;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    const code = /^PLATFORM_[A-Z0-9_]{1,71}$/.test(String(error?.code || ''))
      ? error.code
      : 'PLATFORM_AGGREGATE_QUARANTINE_CLI_FAILED';
    process.stderr.write(`${JSON.stringify({ ok: false, code, error: String(error?.message || '격리 작업 실패') })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  APPLY_CONFIRMATION,
  main,
  parseArgs,
};
