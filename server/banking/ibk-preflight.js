'use strict';

// Local-only deployment preflight. This command validates flags, the approved
// asset pin, and the dedicated masked account loader. It performs no bank or
// database request and never serializes credential values.
const { inspectIbkQuickReadiness } = require('./collectors/ibk-quick-collector');

function buildPreflightReport(options = {}) {
  const environment = options.environment || process.env;
  const readiness = inspectIbkQuickReadiness({
    enabled: environment.PEAKOS_IBK_ENABLED === 'true',
    runtimeEnv: environment,
    secretPath: options.secretPath,
    loadConfig: options.loadConfig,
  });
  return Object.freeze({
    ok: readiness.ready === true,
    status: readiness.status,
    errorCode: readiness.code,
    collectorEnabled: readiness.collectorEnabled === true,
    schedulerEnabled: readiness.schedulerEnabled === true,
    pinReady: readiness.pinReady === true,
    credentialsReady: readiness.credentialsReady === true,
    configuredAccountCount: Number(readiness.configuredAccountCount || 0),
    configuredAccountIds: Object.freeze(
      (readiness.configuredAccounts || []).map(account => String(account.id || '')),
    ),
    networkRequestPerformed: false,
  });
}

function main() {
  const report = buildPreflightReport();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { buildPreflightReport };
