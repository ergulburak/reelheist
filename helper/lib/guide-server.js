'use strict';
// Local read-only guided extension setup server on 127.0.0.1:47861 (fallback 47862..47870).

const http = require('http');
const fs = require('fs');
const path = require('path');

const GUIDE_DIR = path.resolve(__dirname, '..', 'guide');
const DEFAULT_EXT_DIR = path.resolve(__dirname, '..', '..', 'extension');

function detectInstalledBrowsers() {
  const candidates = [
    ['brave', [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ]],
    ['chrome', [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]],
    ['edge', [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]],
  ];
  const found = [];
  for (const [name, paths] of candidates) {
    if (paths.some(p => p && fs.existsSync(p))) found.push(name);
  }
  return found.length ? found : ['brave', 'chrome', 'edge'];
}

function listenOnPort(server, port) {
  return new Promise((resolve, reject) => {
    const onError = err => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function startGuideServer({
  basePort = 47861,
  maxPort = 47870,
  extDir = DEFAULT_EXT_DIR,
  urlFile = null,
  browsers = null,
  initialConnected = false,
} = {}) {
  let extensionConnected = Boolean(initialConnected);
  const browserList = Array.isArray(browsers) ? browsers : detectInstalledBrowsers();
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }

    if (pathname === '/') {
      const indexHtml = fs.readFileSync(path.join(GUIDE_DIR, 'index.html'), 'utf8');
      const boot = `<script>window.__GUIDE_BOOTSTRAP__=${JSON.stringify({ extDir, browsers: browserList })};</script>`;
      const body = indexHtml.replace('</head>', `${boot}</head>`);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (pathname === '/status') {
      const data = JSON.stringify({
        extensionConnected,
        browsers: browserList,
        extDir,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(data);
      return;
    }

    if (pathname === '/guide.js') {
      const jsFile = path.join(GUIDE_DIR, 'guide.js');
      if (fs.existsSync(jsFile)) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(jsFile));
        return;
      }
    }

    const i18nMatch = /^\/i18n\/([a-zA-Z_]+)\.json$/.exec(pathname);
    if (i18nMatch) {
      const file = path.join(GUIDE_DIR, 'i18n', `${i18nMatch[1]}.json`);
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(file));
        return;
      }
    }

    const imgMatch = /^\/img\/(step[123]\.png)$/.exec(pathname);
    if (imgMatch) {
      const file = path.join(GUIDE_DIR, 'img', imgMatch[1]);
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(file));
        return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  server.on('connection', s => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  let boundPort = null;
  if (basePort === 0) {
    boundPort = await listenOnPort(server, 0);
  } else {
    let lastErr = null;
    for (let p = basePort; p <= maxPort; p++) {
      try {
        boundPort = await listenOnPort(server, p);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (boundPort === null) throw lastErr || new Error('Could not bind guide server');
  }

  const url = `http://127.0.0.1:${boundPort}/`;
  if (urlFile) {
    try {
      fs.mkdirSync(path.dirname(urlFile), { recursive: true });
      fs.writeFileSync(urlFile, `[InternetShortcut]\r\nURL=${url}\r\n`, 'utf8');
    } catch { /* ignore if read-only */ }
  }

  return {
    server,
    port: boundPort,
    url,
    markConnected() {
      extensionConnected = true;
    },
    isConnected() {
      return extensionConnected;
    },
    close() {
      return new Promise(resolve => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      });
    },
  };
}

module.exports = { startGuideServer, detectInstalledBrowsers };
