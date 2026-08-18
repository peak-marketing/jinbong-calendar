#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { parseSourceMap } = require('./settlement-source-manifest');
const { captureSourceDirectory } = require('./settlement-source-capture');

function parseArgs(argv) {
  const args = { command: argv[0] || '' };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error('알 수 없는 인수가 있습니다.');
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('명령 인수 값이 누락되었습니다.');
    args[key] = value;
    index += 1;
  }
  return args;
}

async function readSecureSourceMap(filePath) {
  if (!filePath) throw new Error('--source-map-file이 필요합니다.');
  const resolved = path.resolve(filePath);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error('source map은 mode 600인 일반 파일이어야 합니다.');
  }
  return parseSourceMap(await fs.readFile(resolved, 'utf8'));
}

async function main(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  if (args.command !== 'capture') throw new Error('capture 명령을 사용하세요.');
  const timeoutMs = args.timeoutMs === undefined ? 120000 : Number(args.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 120000) {
    throw new Error('--timeout-ms는 5000~120000 범위여야 합니다.');
  }
  const documents = await readSecureSourceMap(args.sourceMapFile);
  const result = await captureSourceDirectory({
    documents,
    sourceDir: args.sourceDir,
    timeoutMs,
    fetchImpl: options.fetchImpl,
    now: options.now || new Date(),
  });
  process.stdout.write(`${JSON.stringify({
    captured: true,
    files: result.manifest.files.length,
    manifestSha256: result.manifest.manifestSha256,
  })}\n`);
  return result;
}

if (require.main === module) {
  main().catch(() => {
    // URLs, document ids, filenames, people and source values remain private.
    process.stderr.write('settlement-source-capture: SETTLEMENT_SOURCE_CAPTURE_FAILED\n');
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, readSecureSourceMap };
