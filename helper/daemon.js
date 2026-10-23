'use strict';
// Background download service. Listens on 127.0.0.1 with a random port and token;
// host.js starts it and hands {port, token} to the extension.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { spawn } = require('child_process');
const P = require('./lib/paths');
const { Queue } = require('./lib/jobs');
const { probe } = require('./lib/probe');
const { findFfmpeg } = require('./lib/mux');
const ytdlp = require('./lib/ytdlp');
const preview = require('./lib/preview');
const { toCoded } = require('./lib/errors');
const { checkExists, resolveInside } = require('./lib/exists');
const { startGuideServer } = require('./lib/guide-server');
const { createUpdateService, applyUpdate } = require('./lib/update');
const releaseConfig = require('./release.json');

const VERSION = require('./package.json').version;
const token = crypto.randomBytes(24).toString('hex');
let guideServer = null;
const updater = createUpdateService({ repo: releaseConfig.repo, current: VERSION });

fs.mkdirSync(P.DATA_DIR, { recursive: true });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFile(P.LOG_FILE, line, () => {});
}

const queue = new Queue({ log });

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': res.req.headers.origin || '*',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function openInExplorer(file, select) {
  const target = require('path').resolve(file);
  const args = select ? [`/select,"${target}"`] : [`"${target}"`];
  spawn('explorer.exe', args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Token',
      'Access-Control-Allow-Methods': 'GET, POST',
    });
    return res.end();
  }
  // Only the extension (with the token from native messaging) may talk to us.
  if (origin && !/^(chrome|moz)-extension:\/\//.test(origin)) return send(res, 403, { error: 'origin' });
  if (req.headers['x-token'] !== token) return send(res, 401, { error: 'token' });
  if (origin && /^(chrome|moz)-extension:\/\//.test(origin)) guideServer?.markConnected();

  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean); // api, jobs, :id, action
    if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });
    const route = `${req.method} /${parts.slice(1, 2).join('/')}`;

    if (route === 'GET /ping') {
      if (url.searchParams.get('hello') === '1') guideServer?.markConnected();
      return send(res, 200, { ok: true, version: VERSION, pid: process.pid, ffmpeg: !!findFfmpeg(), guideUrl: guideServer?.url || null });
    }
    if (route === 'POST /hello') {
      guideServer?.markConnected();
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /probe') {
      const body = await readBody(req);
      if (body.kind === 'ytdlp') {
        if (body.cookies) await ytdlp.saveCookies(body.cookies);
        if (body.playlist) return send(res, 200, { type: 'playlist', ...(await ytdlp.probePlaylist(body.url)) });
        return send(res, 200, ytdlp.normalize(await ytdlp.probeRaw(body.url)));
      }
      return send(res, 200, await probe(body));
    }
    if (route === 'POST /preview') {
      const body = await readBody(req);
      if (typeof body.url !== 'string' || !body.url) return send(res, 400, { error: 'internal', detail: 'url is required' });
      return send(res, 200, { id: preview.startPreview(body.url, { kind: body.kind, playlists: body.playlists, headers: body.headers }).id });
    }
    if (route === 'GET /preview' && parts.length === 3) {
      const st = await preview.previewStatus(parts[2]);
      if (st.state === 'pending') return send(res, 202, { pending: true });
      if (st.state === 'error') {
        log(`Önizleme hatası: ${st.error?.stack || st.error}`);
        const c = toCoded(st.error);
        return send(res, 500, { error: c.code, detail: c.detail });
      }
      if (st.state === 'none') return send(res, 404, { error: 'not found', detail: 'No such preview' });
      const size = (await fsp.stat(st.file)).size;
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': size,
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Cache-Control': 'no-store',
      });
      return fs.createReadStream(st.file).pipe(res);
    }
    if (route === 'GET /settings') return send(res, 200, queue.settings);
    if (route === 'POST /settings') return send(res, 200, await queue.setSettings(await readBody(req)));
    if (route === 'GET /jobs') return send(res, 200, { jobs: queue.list() });
    if (route === 'POST /jobs' && parts.length === 2) {
      const body = await readBody(req);
      const items = Array.isArray(body.jobs) ? body.jobs : [body];
      const added = [];
      for (const j of items) added.push((await queue.add(j)).id);
      return send(res, 200, { ids: added });
    }
    if (req.method === 'POST' && parts[1] === 'jobs' && parts.length === 4) {
      const [, , id, action] = parts;
      const job = queue.get(id);
      if (!job) return send(res, 404, { error: 'job' });
      const body = await readBody(req).catch(() => ({}));
      if (action === 'cancel') await queue.cancel(id);
      else if (action === 'pause') await queue.pause(id);
      else if (action === 'retry') await queue.retry(id, body);
      else if (action === 'remove') await queue.remove(id);
      else if (action === 'open') {
        const play = url.searchParams.get('play') === '1' || body.play === true || body.play === 1;
        if (job.output?.video && fs.existsSync(job.output.video)) openInExplorer(job.output.video, !play);
        else openInExplorer(require('path').join(job.outDir || queue.settings.outDir, job.names.folder), false);
      } else return send(res, 404, { error: 'action' });
      return send(res, 200, { ok: true });
    }
    if (route === 'GET /exists') {
      try {
        return send(res, 200, checkExists(queue.settings.outDir, url.searchParams.get('folder'), url.searchParams.get('base')));
      } catch (e) {
        if (e.code !== 'bad_request') throw e;
        return send(res, 400, { error: e.code, detail: e.detail });
      }
    }
    if (route === 'POST /open-file' || route === 'POST /open-folder') {
      const body = await readBody(req);
      try {
        const file = resolveInside(queue.settings.outDir, body.path);
        openInExplorer(file, route === 'POST /open-folder'); // explorer opens an .mp4 with the default player
      } catch (e) {
        if (e.code !== 'bad_request') throw e;
        return send(res, 400, { error: e.code, detail: e.detail });
      }
      return send(res, 200, { ok: true });
    }
    if (route === 'GET /update') {
      const force = url.searchParams.get('force') === '1';
      const info = await updater.check(force);
      return send(res, 200, { ...info, updateAvailable: info.available });
    }
    if (route === 'POST /update') {
      const info = await updater.check(false);
      if (!info.available || !info.url) return send(res, 400, { error: 'bad_request', detail: 'No update available' });
      return send(res, 200, await applyUpdate({ url: info.url, latest: info.latest, guideUrl: guideServer?.url }));
    }
    if (route === 'POST /shutdown') {
      send(res, 200, { ok: true });
      await queue.save();
      await guideServer?.close().catch(() => {});
      setTimeout(() => process.exit(0), 100);
      return;
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    log(`API hata ${req.method} ${req.url}: ${e.stack || e}`);
    const c = toCoded(e);
    return send(res, 500, { error: c.code, detail: c.detail });
  }
});

async function otherDaemonAlive() {
  try {
    const info = JSON.parse(fs.readFileSync(P.DAEMON_INFO, 'utf8'));
    if (info.pid === process.pid) return false;
    const r = await fetch(`http://127.0.0.1:${info.port}/api/ping`, {
      headers: { 'X-Token': info.token },
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

(async () => {
  if (await otherDaemonAlive()) {
    log(`İkinci daemon kapandı (pid ${process.pid})`);
    process.exit(0);
  }
  await queue.load();
  preview.startCleaner(); // drop old preview files now and every hour
  updater.startBackground();
  // YouTube changes often; keep yt-dlp fresh (download if missing, update if older than 3 days).
  ytdlp.ensureYtdlp({ update: true, log }).catch(e => log(e.message));
  const parentDir = require('path').resolve(__dirname, '..');
  const isPackagedApp = fs.existsSync(require('path').join(parentDir, 'host.cmd'));
  const urlFile = isPackagedApp
    ? require('path').join(parentDir, 'guide.url')
    : require('path').join(P.DATA_DIR, 'guide.url');
  guideServer = await startGuideServer({ urlFile }).catch(e => {
    log(`Guide server error: ${e.message}`);
    return null;
  });
  if (guideServer && isPackagedApp) {
    try {
      fs.writeFileSync(require('path').join(P.DATA_DIR, 'guide.url'), `[InternetShortcut]\r\nURL=${guideServer.url}\r\n`, 'utf8');
    } catch { /* ignore */ }
  }
  server.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    const info = { port, token, pid: process.pid, version: VERSION, guideUrl: guideServer?.url || null, startedAt: Date.now() };
    const tmp = P.DAEMON_INFO + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(info));
    await fsp.rename(tmp, P.DAEMON_INFO);
    log(`Daemon başladı: port ${port}, pid ${process.pid}`);
  });
})();

process.on('uncaughtException', e => log(`uncaughtException: ${e.stack || e}`));
process.on('unhandledRejection', e => log(`unhandledRejection: ${e?.stack || e}`));
