'use strict';

const AUTO_MATCH_MAX_AGE_ENV = 'PEAKOS_BANK_AUTO_MATCH_MAX_AGE_DAYS';
const DEFAULT_AUTO_MATCH_MAX_AGE_DAYS = 30;
const MAX_AUTO_MATCH_MAX_AGE_DAYS = 90;
const AUTO_MATCH_FUTURE_GRACE_MS = 60 * 60 * 1000;

function parseAutoMatchMaxAgeDays(value = process.env[AUTO_MATCH_MAX_AGE_ENV]) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_AUTO_MATCH_MAX_AGE_DAYS;
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${AUTO_MATCH_MAX_AGE_ENV} must be an integer between 0 and ${MAX_AUTO_MATCH_MAX_AGE_DAYS}.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_AUTO_MATCH_MAX_AGE_DAYS) {
    throw new Error(`${AUTO_MATCH_MAX_AGE_ENV} must be an integer between 0 and ${MAX_AUTO_MATCH_MAX_AGE_DAYS}.`);
  }
  return parsed;
}

const AUTO_MATCH_MAX_AGE_DAYS = parseAutoMatchMaxAgeDays();

function isWithinAutoMatchWindow(candidateCreatedAt, transactionAt, maxAgeDays = AUTO_MATCH_MAX_AGE_DAYS) {
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays <= 0 || maxAgeDays > MAX_AUTO_MATCH_MAX_AGE_DAYS) {
    return false;
  }
  if (candidateCreatedAt === null || candidateCreatedAt === undefined || candidateCreatedAt === ''
      || transactionAt === null || transactionAt === undefined || transactionAt === '') {
    return false;
  }
  const candidateTime = candidateCreatedAt instanceof Date
    ? candidateCreatedAt.getTime()
    : new Date(candidateCreatedAt).getTime();
  const transactionTime = transactionAt instanceof Date
    ? transactionAt.getTime()
    : new Date(transactionAt).getTime();
  if (!Number.isFinite(candidateTime) || !Number.isFinite(transactionTime)) return false;
  const lowerBound = transactionTime - (maxAgeDays * 24 * 60 * 60 * 1000);
  return candidateTime >= lowerBound
    && candidateTime <= transactionTime + AUTO_MATCH_FUTURE_GRACE_MS;
}

module.exports = {
  AUTO_MATCH_MAX_AGE_DAYS,
  AUTO_MATCH_MAX_AGE_ENV,
  DEFAULT_AUTO_MATCH_MAX_AGE_DAYS,
  MAX_AUTO_MATCH_MAX_AGE_DAYS,
  isWithinAutoMatchWindow,
  parseAutoMatchMaxAgeDays,
};
