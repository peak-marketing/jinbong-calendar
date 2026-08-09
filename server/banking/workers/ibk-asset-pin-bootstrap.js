'use strict';

// Trust-on-first-use helper. It reads no account secret, executes no downloaded
// code, and prints only the single public asset pin used by the provider.
const crypto = require('node:crypto');
const {
  IBK_BROWSER_USER_AGENT: RUNTIME_USER_AGENT,
  IBK_TRANSKEY_JS_URL: ASSET_URL,
} = require('../providers/ibk-quick-readonly');

const OUTPUT_KEY = 'PEAKOS_IBK_TRANSKEY_JS_SHA256';
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 30_000;

function validateUrl(value) {
  const url = new URL(value);
  const expected = new URL(ASSET_URL);
  if (url.protocol !== 'https:' || url.hostname !== expected.hostname
    || url.pathname !== expected.pathname || url.search || url.hash
    || (url.port && url.port !== '443') || url.username || url.password) {
    throw new Error('invalid asset URL');
  }
  return url;
}

async function readLimited(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error('oversized asset');
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error('oversized asset');
    return bytes;
  }
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('oversized asset');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

async function download(signal) {
  const response = await fetch(validateUrl(ASSET_URL), {
    method: 'GET',
    redirect: 'manual',
    signal,
    headers: {
      'User-Agent': RUNTIME_USER_AGENT,
    },
  });
  if (response.status < 200 || response.status >= 300) throw new Error('asset request failed');
  if (response.url) validateUrl(response.url);
  return readLimited(response);
}

function sriSha256(bytes) {
  return `sha256-${crypto.createHash('sha256').update(bytes).digest('base64')}`;
}

async function main() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const first = await download(controller.signal);
    const second = await download(controller.signal);
    const firstPin = sriSha256(first);
    if (firstPin !== sriSha256(second)) throw new Error('asset changed during verification');
    process.stdout.write(`${OUTPUT_KEY}=${firstPin}\n`);
  } finally {
    clearTimeout(timeout);
  }
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('IBK asset pin bootstrap failed.\n');
    process.exitCode = 1;
  });
}

module.exports = { ASSET_URL, OUTPUT_KEY, RUNTIME_USER_AGENT, sriSha256, validateUrl };
