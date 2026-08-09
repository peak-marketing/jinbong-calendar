'use strict';

const {
  createIbkQuickCollector,
  IBK_ACCOUNT_IDS,
} = require('./collectors/ibk-quick-collector');
const { loadIbkAccountConfig } = require('./ibk-account-config');

const ACCOUNT_ID_SET = new Set(IBK_ACCOUNT_IDS);
const SAFE_FAILURE_CODES = new Set([
  'DRY_RUN_ARGUMENT_INVALID',
  'DRY_RUN_ACCOUNT_INVALID',
  'LIVE_READ_CONFIRMATION_REQUIRED',
  'IBK_DRY_RUN_FAILED',
  'IBK_ACCOUNT_NOT_CONFIGURED',
  'IBK_ACCOUNT_MISMATCH',
  'IBK_ASSET_PIN_REQUIRED',
  'IBK_ASSET_PIN_MISMATCH',
  'IBK_BANK_RESPONSE_ERROR',
  'IBK_CONFIGURATION_ERROR',
  'IBK_NETWORK_ERROR',
  'IBK_NETWORK_PAGE',
  'IBK_NETWORK_TRANSKEY',
  'IBK_NETWORK_TRANSACTION',
  'IBK_QUERY_FAILED',
  'IBK_RANGE_INVALID',
  'IBK_RANGE_TOO_LARGE',
  'IBK_REQUEST_TIMEOUT',
  'IBK_RESPONSE_FORMAT_CHANGED',
  'IBK_RESPONSE_TOO_LARGE',
  'IBK_TRANSKEY_ERROR',
  'IBK_WORKER_FAILED',
  'IBK_WORKER_INVALID_OUTPUT',
  'IBK_WORKER_OUTPUT_LIMIT',
  'IBK_WORKER_TIMEOUT',
  'IBK_FORMAT_PAGE_RESPONSE',
  'IBK_FORMAT_TRANSKEY_RESPONSE',
  'IBK_FORMAT_TRANSACTION_RESPONSE',
  'IBK_FORMAT_TRANSACTION_STRUCTURE',
  'IBK_FORMAT_TRANSACTION_DATE',
  'IBK_FORMAT_WITHDRAWAL_AMOUNT',
  'IBK_FORMAT_OBJECT_WITHDRAWAL_AMOUNT',
  'IBK_FORMAT_TABLE_WITHDRAWAL_AMOUNT',
  'IBK_FORMAT_OBJECT_WITHDRAWAL_TEXT',
  'IBK_FORMAT_OBJECT_WITHDRAWAL_SIGNED',
  'IBK_FORMAT_OBJECT_WITHDRAWAL_DECIMAL',
  'IBK_FORMAT_OBJECT_WITHDRAWAL_CURRENCY',
  'IBK_FORMAT_OBJECT_WITHDRAWAL_MIXED',
  'IBK_FORMAT_DEPOSIT_AMOUNT',
  'IBK_FORMAT_BALANCE',
  'IBK_FORMAT_DIRECTION',
]);

class DryRunArgumentError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function parseArguments(argv) {
  const parsed = { accountId: null, from: null, to: null, liveRead: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--live-read') {
      parsed.liveRead = true;
      continue;
    }
    if (argument === '--account' || argument === '--from' || argument === '--to') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new DryRunArgumentError('DRY_RUN_ARGUMENT_INVALID');
      if (argument === '--account') parsed.accountId = value;
      if (argument === '--from') parsed.from = value;
      if (argument === '--to') parsed.to = value;
      index += 1;
      continue;
    }
    throw new DryRunArgumentError('DRY_RUN_ARGUMENT_INVALID');
  }
  if (!ACCOUNT_ID_SET.has(parsed.accountId)) throw new DryRunArgumentError('DRY_RUN_ACCOUNT_INVALID');
  if (!parsed.liveRead) throw new DryRunArgumentError('LIVE_READ_CONFIRMATION_REQUIRED');
  return Object.freeze(parsed);
}

async function runDryRead(options) {
  const createCollector = options.createCollector || createIbkQuickCollector;
  const collector = options.collector || createCollector({
    enabled: true,
    secretPath: options.secretPath,
  });
  let account = options.account;
  if (!account && !options.collector) {
    const configOptions = options.secretPath === undefined
      ? undefined
      : { secretPath: options.secretPath };
    const registry = (options.loadConfig || loadIbkAccountConfig)(configOptions);
    const publicAccount = registry.publicAccounts.find(({ id }) => id === options.accountId);
    if (!publicAccount) throw new DryRunArgumentError('DRY_RUN_ACCOUNT_INVALID');
    account = Object.freeze({
      id: publicAccount.id,
      provider: 'IBK_QUICK',
      accountNumberMasked: publicAccount.accountNumberMasked,
    });
  }
  const result = await collector({
    account: account || Object.freeze({ id: options.accountId, provider: 'IBK_QUICK' }),
    from: options.from,
    to: options.to,
    requestId: null,
  });
  const stableKeyCount = result.transactions.reduce(
    (count, transaction) => count + (transaction.providerKeyStable === true ? 1 : 0),
    0,
  );
  return Object.freeze({
    ok: true,
    accountId: options.accountId,
    range: Object.freeze({ from: result.from, to: result.to }),
    transactionCount: result.transactions.length,
    stableKeyCount,
    fallbackKeyCount: result.transactions.length - stableKeyCount,
    noData: result.noData === true || result.transactions.length === 0,
  });
}

function safeFailure(error, accountId = null) {
  const code = SAFE_FAILURE_CODES.has(error?.code)
    ? error.code
    : 'IBK_DRY_RUN_FAILED';
  return Object.freeze({ ok: false, accountId, errorCode: code });
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
    process.stdout.write(`${JSON.stringify(await runDryRead(options))}\n`);
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(`${JSON.stringify(safeFailure(error, options?.accountId || null))}\n`);
  }
}

if (require.main === module) main();

module.exports = {
  DryRunArgumentError,
  parseArguments,
  runDryRead,
  safeFailure,
};
