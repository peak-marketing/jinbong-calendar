'use strict';

const { REQUIRED_PEOPLE } = require('./settlement-source-manifest');

const UID_PATTERN = /^[A-Za-z0-9:_-]{6,256}$/;

function parseUidMap(rawValue) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawValue || ''));
  } catch (_) {
    throw new Error('PEAKOS_SETTLEMENT_UID_MAP_JSON 형식이 올바르지 않습니다.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PEAKOS_SETTLEMENT_UID_MAP_JSON 설정이 필요합니다.');
  }

  const actualNames = Object.keys(parsed);
  if (actualNames.length !== REQUIRED_PEOPLE.length
      || actualNames.some(name => !REQUIRED_PEOPLE.includes(name))) {
    throw new Error('이관 UID 매핑은 지정된 7명만 정확히 포함해야 합니다.');
  }

  const uidMap = new Map();
  const seenUids = new Set();
  for (const name of REQUIRED_PEOPLE) {
    const configured = parsed[name];
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
      throw new Error(`${name} UID와 확인용 이메일을 함께 설정해야 합니다.`);
    }
    const uid = String(configured.uid || '').trim();
    const expectedEmail = String(configured.email || '').trim().toLocaleLowerCase('en-US');
    if (!UID_PATTERN.test(uid)) throw new Error(`${name} UID가 누락되었거나 형식이 올바르지 않습니다.`);
    if (seenUids.has(uid)) throw new Error('이관 UID는 사람별로 중복되지 않아야 합니다.');
    if (!expectedEmail || expectedEmail.length > 320 || !expectedEmail.includes('@')) {
      throw new Error(`${name} 확인용 이메일 형식이 올바르지 않습니다.`);
    }
    uidMap.set(name, Object.freeze({ uid, expectedEmail }));
    seenUids.add(uid);
  }
  return uidMap;
}

function maskedUidMap(uidMap) {
  return Object.fromEntries(REQUIRED_PEOPLE.map(name => [name, {
    configured: Boolean(uidMap.get(name)?.uid),
    emailPinned: Boolean(uidMap.get(name)?.expectedEmail),
  }]));
}

async function verifyUidMap(client, uidMap, { lock = true } = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('DB client.query가 필요합니다.');
  if (!(uidMap instanceof Map) || uidMap.size !== REQUIRED_PEOPLE.length) {
    throw new Error('검증할 7명 UID 매핑이 필요합니다.');
  }
  const uids = REQUIRED_PEOPLE.map(name => uidMap.get(name)?.uid);
  if (uids.some(uid => !UID_PATTERN.test(String(uid || ''))) || new Set(uids).size !== uids.length) {
    throw new Error('검증할 UID가 누락·중복되었습니다.');
  }

  const result = await client.query(
    `SELECT uid, name, email, approved, COALESCE(is_active, true) AS is_active
       FROM users
      WHERE uid = ANY($1::text[])
      ${lock ? 'FOR SHARE' : ''}`,
    [uids],
  );
  const byUid = new Map(result.rows.map(row => [String(row.uid || ''), row]));
  if (byUid.size !== uids.length) throw new Error('이관 대상 UID 중 users에 없는 계정이 있습니다.');

  for (const name of REQUIRED_PEOPLE) {
    const expected = uidMap.get(name);
    const user = byUid.get(expected.uid);
    if (!user || String(user.name || '').trim() !== name) {
      throw new Error(`${name} UID와 users.name이 일치하지 않습니다.`);
    }
    if (user.approved !== true || user.is_active !== true) {
      throw new Error(`${name} 계정이 미승인 또는 비활성 상태입니다.`);
    }
    if (expected.expectedEmail
        && String(user.email || '').trim().toLocaleLowerCase('en-US') !== expected.expectedEmail) {
      throw new Error(`${name} UID와 확인용 이메일이 일치하지 않습니다.`);
    }
  }
  return maskedUidMap(uidMap);
}

module.exports = {
  UID_PATTERN,
  maskedUidMap,
  parseUidMap,
  verifyUidMap,
};
