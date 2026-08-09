'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const bootstrap = require('./ibk-asset-pin-bootstrap');

test('bootstrap is fixed to one public inert asset and returns only an SRI hash', () => {
  assert.equal(bootstrap.OUTPUT_KEY, 'PEAKOS_IBK_TRANSKEY_JS_SHA256');
  assert.equal(
    bootstrap.ASSET_URL,
    'https://kiup.ibk.co.kr/IBK/uib/sw/raon/Transkey/transkey.js',
  );
  assert.match(bootstrap.sriSha256(Buffer.from('fixture')), /^sha256-[A-Za-z0-9+/]{43}=$/);
  assert.equal(bootstrap.validateUrl(bootstrap.ASSET_URL).hostname, 'kiup.ibk.co.kr');
  assert.throws(() => bootstrap.validateUrl('https://kiup.ibk.co.kr.evil.example/transkey.js'));
});
