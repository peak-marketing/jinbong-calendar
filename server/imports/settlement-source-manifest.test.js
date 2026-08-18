'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  REQUIRED_PEOPLE,
  SOURCE_DOCUMENTS,
  parseSourceMap,
  sourceManifestSha256,
  sourceManifestSnapshot,
} = require('./settlement-source-manifest');
const { parseUidMap, verifyUidMap } = require('./settlement-uid-map');

function sourceConfig(suffix = '') {
  return Object.fromEntries(SOURCE_DOCUMENTS.map((document, index) => [document.key, {
    documentId: `externaldocumentidentifier${String(index).padStart(3, '0')}${suffix}`,
    initialGid: String(1000 + index),
  }]));
}

function uidConfig() {
  return Object.fromEntries(REQUIRED_PEOPLE.map((name, index) => [name, {
    uid: `firebase-uid-${index}`,
    email: `staff${index}@example.test`,
  }]));
}

test('공개 manifest에 Google document id와 UID가 하드코딩되지 않는다', () => {
  for (const document of SOURCE_DOCUMENTS) {
    assert.equal(document.documentId, undefined);
    assert.equal(document.initialGid, undefined);
    assert.equal(document.uid, undefined);
  }
});

test('원본 매핑은 고정 7개 key와 유일한 문서 ID를 fail-closed로 검증한다', () => {
  const documents = parseSourceMap(JSON.stringify(sourceConfig()));
  assert.equal(documents.length, 7);
  assert.deepEqual(documents.map(item => item.ownerName), [...REQUIRED_PEOPLE]);
  assert.throws(() => parseSourceMap('{}'), /지정된 7개/);
  const duplicate = sourceConfig();
  duplicate[SOURCE_DOCUMENTS[1].key].documentId = duplicate[SOURCE_DOCUMENTS[0].key].documentId;
  assert.throws(() => parseSourceMap(JSON.stringify(duplicate)), /누락·중복/);
});

test('UID 매핑은 7명 모두 exact email pin을 요구한다', () => {
  const valid = uidConfig();
  const parsed = parseUidMap(JSON.stringify(valid));
  assert.equal(parsed.size, 7);
  const bare = { ...valid, '김주현': valid['김주현'].uid };
  assert.throws(() => parseUidMap(JSON.stringify(bare)), /이메일/);
  const missingEmail = { ...valid, '김주현': { uid: valid['김주현'].uid } };
  assert.throws(() => parseUidMap(JSON.stringify(missingEmail)), /이메일/);
});

test('DB UID 검증은 name·email·approved·active를 모두 확인하고 비밀값은 반환하지 않는다', async () => {
  const configured = uidConfig();
  const uidMap = parseUidMap(JSON.stringify(configured));
  const result = await verifyUidMap({
    query: async (sql, params) => {
      assert.match(sql, /FROM users/);
      assert.equal(params[0].length, 7);
      return {
        rows: REQUIRED_PEOPLE.map(name => ({
          uid: configured[name].uid,
          name,
          email: configured[name].email,
          approved: true,
          is_active: true,
        })),
      };
    },
  }, uidMap);
  assert.deepEqual(Object.keys(result), [...REQUIRED_PEOPLE]);
  assert.equal(JSON.stringify(result).includes('firebase-uid'), false);
  assert.equal(JSON.stringify(result).includes('@example.test'), false);
});

test('dry-run UID 검증은 read-only transaction에서 row lock을 요구하지 않는다', async () => {
  const configured = uidConfig();
  const uidMap = parseUidMap(JSON.stringify(configured));
  await verifyUidMap({
    query: async sql => {
      assert.doesNotMatch(sql, /FOR SHARE/);
      return {
        rows: REQUIRED_PEOPLE.map(name => ({
          uid: configured[name].uid,
          name,
          email: configured[name].email,
          approved: true,
          is_active: true,
        })),
      };
    },
  }, uidMap, { lock: false });
});

test('content hash·byte length가 snapshot과 manifest SHA에 포함된다', () => {
  const documents = parseSourceMap(JSON.stringify(sourceConfig()));
  const files = documents.map((document, index) => ({
    key: document.key,
    sha256: String(index).padStart(64, 'a'),
    byteLength: 100 + index,
  }));
  const snapshot = sourceManifestSnapshot(documents, files);
  assert.equal(snapshot.sourceFiles.length, 7);
  assert.equal(snapshot.sourceFiles.every(file => /^[0-9a-f]{64}$/.test(file.sha256)), true);
  const first = sourceManifestSha256(documents, files);
  const changed = files.map(item => ({ ...item }));
  changed[0].sha256 = 'f'.repeat(64);
  assert.notEqual(first, sourceManifestSha256(documents, changed));
  assert.equal(JSON.stringify(snapshot).includes(documents[0].documentId), false);
});
