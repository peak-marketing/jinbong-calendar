'use strict';

process.stderr.write([
  process.env.IBK_QUICK_ACCOUNT_NUMBER,
  process.env.IBK_QUICK_ACCOUNT_PASSWORD,
  process.env.IBK_QUICK_IDENTITY_NUMBER,
].join(' '));
process.stdout.write(JSON.stringify({
  ok: false,
  error: {
    code: 'IBK_NETWORK_ERROR',
    message: `unsafe ${process.env.IBK_QUICK_ACCOUNT_NUMBER}`,
  },
}));
process.exitCode = 1;
