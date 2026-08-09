'use strict';

const allowedEnvironment = new Set([
  'NODE_ENV',
  'TZ',
  'LANG',
  'IBK_QUICK_ACCOUNT_ID',
  'IBK_QUICK_ACCOUNT_NUMBER',
  'IBK_QUICK_ACCOUNT_PASSWORD',
  'IBK_QUICK_IDENTITY_NUMBER',
  'IBK_QUICK_TIMEOUT_MS',
  'IBK_QUICK_TRANSKEY_JS_SHA256',
]);
let source = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { source += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(source);
  const invalidEnvironment = Object.keys(process.env).some((name) => !allowedEnvironment.has(name))
    || process.env.IBK_QUICK_ACCOUNT_ID !== request.accountId
    || !process.env.IBK_QUICK_ACCOUNT_NUMBER
    || !process.env.IBK_QUICK_ACCOUNT_PASSWORD
    || !process.env.IBK_QUICK_IDENTITY_NUMBER;
  if (invalidEnvironment) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: { code: 'IBK_WORKER_FAILED', message: 'fixture environment rejected' },
    }));
    process.exitCode = 1;
    return;
  }
  const toKst = (value) => {
    const shifted = new Date(new Date(value).getTime() + 9 * 60 * 60 * 1_000).toISOString();
    return `${shifted.slice(0, 19)}+09:00`;
  };
  process.stdout.write(JSON.stringify({
    ok: true,
    accountId: request.accountId,
    from: toKst(request.from),
    to: toKst(request.to),
    noData: false,
    transactions: [{
      providerTransactionKey: `IBK_QUICK:${'a'.repeat(32)}`,
      providerKeyStable: false,
      transactionAt: '2026-08-05T10:20:30+09:00',
      direction: 'DEPOSIT',
      amount: 110000,
      balance: 5020000,
      summary: 'fixture transaction',
      counterpartyName: 'fixture counterparty',
      counterpartyAccountMasked: '12-******-7890',
      branch: 'fixture branch',
    }],
  }));
});
