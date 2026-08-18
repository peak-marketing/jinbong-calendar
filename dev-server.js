const fs = require('fs');
const http = require('http');
const path = require('path');

const root = __dirname;
const port = Number(process.env.DEV_PORT || 4180);
const apiPort = Number(process.env.API_PORT || 4110);

const publicFiles = new Map([
  ['/', 'business-os-preview.html'],
  ['/business-os-preview.html', 'business-os-preview.html'],
  ['/business-os-live.css', 'business-os-live.css'],
  ['/business-os-preview.js', 'business-os-preview.js'],
  ['/logo-trimmed.png', 'logo-trimmed.png'],
  ['/os/business-os-live.css', 'business-os-live.css'],
  ['/os/business-os-preview.js', 'business-os-preview.js'],
  ['/os/logo-trimmed.png', 'logo-trimmed.png'],
]);

const osShellPaths = new Set(['/os', '/os/', '/os/login', '/os/login/']);

function isOsShellPath(pathname) {
  if (osShellPaths.has(pathname)) return true;
  return /^\/os\/w\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/?$/.test(pathname);
}

const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
};

function writeText(req, res, statusCode, body, headers = {}) {
  const data = Buffer.from(body);
  res.writeHead(statusCode, {
    'Content-Length': data.length,
    'Content-Type': 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function proxyApi(req, res, targetApiPort) {
  const proxy = http.request({
    hostname: '127.0.0.1',
    port: targetApiPort,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${targetApiPort}`,
    },
  }, upstream => {
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  });

  proxy.on('error', error => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `Local API unavailable: ${error.message}` }));
  });

  req.pipe(proxy);
}

function serveFile(req, res, options) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeText(req, res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    writeText(req, res, 400, 'Bad request');
    return;
  }

  const filename = options.publicFiles.get(pathname)
    || (options.osShellFile && isOsShellPath(pathname) ? options.osShellFile : null);
  if (!filename) {
    writeText(req, res, 404, 'Not found');
    return;
  }

  const filePath = path.join(options.realRoot, filename);
  fs.realpath(filePath, (realpathError, resolvedPath) => {
    const relative = realpathError ? '' : path.relative(options.realRoot, resolvedPath);
    if (
      realpathError
      || !relative
      || relative.startsWith('..')
      || path.isAbsolute(relative)
      || relative !== filename
    ) {
      writeText(req, res, realpathError && realpathError.code === 'ENOENT' ? 404 : 403, realpathError && realpathError.code === 'ENOENT' ? 'Not found' : 'Forbidden');
      return;
    }

    fs.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, (openError, fd) => {
      if (openError) {
        writeText(req, res, openError.code === 'ENOENT' ? 404 : 403, openError.code === 'ENOENT' ? 'Not found' : 'Forbidden');
        return;
      }

      fs.fstat(fd, (statError, stats) => {
        if (statError || !stats.isFile()) {
          fs.close(fd, () => {});
          writeText(req, res, 403, 'Forbidden');
          return;
        }

        res.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Length': stats.size,
          'Content-Type': mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        });

        if (req.method === 'HEAD') {
          fs.close(fd, () => {});
          res.end();
          return;
        }

        const stream = fs.createReadStream(filePath, { fd, autoClose: true });
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      });
    });
  });
}

function createDevServer(options = {}) {
  const rootDir = options.rootDir || root;
  const realRoot = fs.realpathSync(rootDir);
  const targetApiPort = options.apiPort || apiPort;
  const allowedPublicFiles = options.publicFiles || publicFiles;

  return http.createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      writeText(req, res, 400, 'Bad request');
      return;
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      proxyApi(req, res, targetApiPort);
      return;
    }
    serveFile(req, res, {
      publicFiles: allowedPublicFiles,
      realRoot,
      osShellFile: options.osShellFile === undefined
        ? 'business-os-preview.html'
        : options.osShellFile,
    });
  });
}

if (require.main === module) {
  createDevServer().listen(port, '127.0.0.1', () => {
    console.log(`Peak Marketing Business OS: http://127.0.0.1:${port}`);
    console.log(`API proxy: http://127.0.0.1:${apiPort}`);
  });
}

module.exports = { createDevServer, isOsShellPath, publicFiles };
