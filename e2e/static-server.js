// Minimal static server for e2e tests. Serves /var/www/jinbong-calendar/
// so that index.html and sw.js load as they would in production, without
// needing nginx. API calls are stubbed inside tests via page.route().
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 4788);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400); return res.end('bad url');
  }
  if (pathname === '/') pathname = '/index.html';
  const fsPath = path.join(ROOT, pathname);
  if (!fsPath.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fsPath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(fsPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('static server at http://127.0.0.1:' + PORT);
});
