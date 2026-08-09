const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDevServer } = require('../dev-server');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function request(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: options.method || 'GET',
      headers: options.headers,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
        statusCode: res.statusCode,
      }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('serves only allowlisted assets and handles HEAD without a body', async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peakos-dev-server-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(rootDir, 'public.html'), 'public');
  fs.writeFileSync(path.join(rootDir, 'secret.json'), 'secret');

  const server = createDevServer({
    rootDir,
    publicFiles: new Map([['/', 'public.html'], ['/public.html', 'public.html']]),
  });
  const port = await listen(server);
  t.after(() => close(server));

  const page = await request(port, '/');
  assert.equal(page.statusCode, 200);
  assert.equal(page.body, 'public');

  const head = await request(port, '/public.html', { method: 'HEAD' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], String(Buffer.byteLength('public')));

  assert.equal((await request(port, '/secret.json')).statusCode, 404);
  assert.equal((await request(port, '/dev-server.js')).statusCode, 404);
  assert.equal((await request(port, '/..%2fsecret.json')).statusCode, 404);

  const missingHead = await request(port, '/secret.json', { method: 'HEAD' });
  assert.equal(missingHead.statusCode, 404);
  assert.equal(missingHead.body, '');

  const rejectedMethod = await request(port, '/', { method: 'POST' });
  assert.equal(rejectedMethod.statusCode, 405);
  assert.equal(rejectedMethod.headers.allow, 'GET, HEAD');
});

test('rejects an allowlisted path when the file is a symlink', async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peakos-dev-server-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peakos-dev-server-outside-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(rootDir, 'public.html'));

  const server = createDevServer({
    rootDir,
    publicFiles: new Map([['/', 'public.html']]),
  });
  const port = await listen(server);
  t.after(() => close(server));

  const response = await request(port, '/');
  assert.equal(response.statusCode, 403);
  assert.equal(response.body, 'Forbidden');
});

test('keeps API methods, request bodies, and responses proxied', async t => {
  const api = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, path: req.url, body: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  const apiPort = await listen(api);
  t.after(() => close(api));

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peakos-dev-server-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const server = createDevServer({ rootDir, apiPort, publicFiles: new Map() });
  const port = await listen(server);
  t.after(() => close(server));

  const response = await request(port, '/api/example?value=1', {
    method: 'POST',
    body: 'payload',
    headers: { 'Content-Type': 'text/plain', 'Content-Length': '7' },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(JSON.parse(response.body), {
    method: 'POST',
    path: '/api/example?value=1',
    body: 'payload',
  });
});
