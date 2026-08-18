'use strict';

const PLATFORM_SYNC_CRON = '17 2 * * *';
const PLATFORM_SYNC_TIME_ZONE = 'Asia/Seoul';

function safeSyncCode(error) {
  const code = String(error?.code || '');
  return /^PLATFORM_[A-Z0-9_]{1,71}$/.test(code)
    ? code
    : 'PLATFORM_CONNECTOR_SYNC_FAILED';
}

function createPlatformSettlementSyncRuntime({
  service,
  scheduleCron,
  enabled = false,
  backgroundJobsEnabled = true,
  logger = console,
} = {}) {
  if (!service
      || !Array.isArray(service.configuredProviders)
      || typeof service.syncCurrentAndPrevious !== 'function'
      || typeof scheduleCron !== 'function') {
    throw new TypeError('platform settlement sync runtime 설정이 올바르지 않습니다.');
  }

  let running = false;

  async function run(trigger = 'scheduled') {
    const safeTrigger = ['scheduled', 'startup'].includes(trigger) ? trigger : 'internal';
    if (!enabled || !backgroundJobsEnabled) {
      return { skipped: true, reason: 'disabled' };
    }
    if (!service.configuredProviders.length) {
      return { skipped: true, reason: 'not_configured' };
    }
    if (running) return { skipped: true, reason: 'busy' };

    running = true;
    try {
      const results = await service.syncCurrentAndPrevious();
      const months = Array.isArray(results) ? results : [];
      const providerResults = months.flatMap(result => (
        Array.isArray(result?.providers) ? result.providers : []
      ));
      const failedProviders = providerResults.filter(result => result?.ok !== true).length;
      logger.info?.(
        `[PEAK OS] platform settlement sync trigger=${safeTrigger}`
        + ` months=${months.length} providers=${providerResults.length}`
        + ` failed=${failedProviders}`,
      );
      return {
        skipped: false,
        months: months.length,
        providers: providerResults.length,
        failedProviders,
      };
    } catch (error) {
      const code = safeSyncCode(error);
      logger.error?.(
        `[PEAK OS] platform settlement sync trigger=${safeTrigger} code=${code}`,
      );
      return { skipped: false, failed: true, code };
    } finally {
      running = false;
    }
  }

  function startScheduler() {
    if (!enabled || !backgroundJobsEnabled || !service.configuredProviders.length) return null;
    return scheduleCron(
      PLATFORM_SYNC_CRON,
      () => run('scheduled'),
      { timezone: PLATFORM_SYNC_TIME_ZONE },
    );
  }

  return Object.freeze({ run, startScheduler });
}

module.exports = {
  PLATFORM_SYNC_CRON,
  PLATFORM_SYNC_TIME_ZONE,
  createPlatformSettlementSyncRuntime,
  safeSyncCode,
};
