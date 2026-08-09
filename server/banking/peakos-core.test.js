'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ensurePeakosCoreInfrastructure } = require('./peakos-core');

test('clean restore용 core migration은 모든 PEAK OS 선행 테이블을 만든다', async () => {
  const calls = [];
  await ensurePeakosCoreInfrastructure({ query: async sql => { calls.push(String(sql)); } });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS peakos_intake/);
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS peakos_credit/);
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS peakos_price/);
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS peakos_monthly/);
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS peakos_fund/);
});
