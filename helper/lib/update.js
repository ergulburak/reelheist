'use strict';
// Semver comparison, GitHub release update check, and installer download/launch.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function parseSemver(v) {
  const clean = String(v || '').trim().replace(/^v/i, '');
  const [core, pre = ''] = clean.split('-', 2);
  const parts = core.split('.').map(n => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return { major: parts[0], minor: parts[1], patch: parts[2], pre };
}

function compareVersions(a, b) {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
  if (!va.pre && !vb.pre) return 0;
  // Prerelease < release (e.g. 0.2.0-beta < 0.2.0)
  if (va.pre && !vb.pre) return -1;
  if (!va.pre && vb.pre) return 1;
  return va.pre === vb.pre ? 0 : (va.pre < vb.pre ? -1 : 1);
}

async function checkUpdate({ repo, current, fetch = globalThis.fetch } = {}) {
  const fallback = { current: String(current || ''), latest: null, url: null, available: false };
  if (!repo || !current || typeof fetch !== 'function') return fallback;
  try {
    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    const res = await fetch(apiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ReelHeist-Helper' },
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    const tag = String(data?.tag_name || '').trim();
    if (!tag) return fallback;
    const latest = tag.replace(/^v/i, '');
    const available = compareVersions(current, latest) < 0;
    const expectedAsset = `ReelHeist-Setup-${latest}.exe`;
    const assets = Array.isArray(data?.assets) ? data.assets : [];
    const match = assets.find(a => a && a.name === expectedAsset)
      || assets.find(a => a && /^ReelHeist-Setup-.*\.exe$/i.test(a.name || ''));
    const url = match?.browser_download_url || data?.html_url || `https://github.com/${repo}/releases/latest`;
    return { current: String(current), latest, url, available };
  } catch {
    return fallback;
  }
}

function downloadWithCurl(url, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn('curl.exe', ['-sSL', '--ssl-no-revoke', '--fail', '-o', dest, url], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(dest) : reject(new Error(err.trim() || `curl exit ${code}`))));
  });
}

async function applyUpdate({ url, latest, guideUrl }) {
  if (!url) throw new Error('Update URL is missing');
  const dest = path.join(os.tmpdir(), `ReelHeist-Setup-${latest || 'latest'}.exe`);
  await downloadWithCurl(url, dest);
  if (!fs.existsSync(dest)) throw new Error('Downloaded installer not found');
  spawn(dest, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  }).unref();
  if (guideUrl) {
    spawn('explorer.exe', [guideUrl], { detached: true, stdio: 'ignore' }).unref();
  }
  return { ok: true, installer: dest };
}

function createUpdateService({ repo, current, fetch = globalThis.fetch, intervalMs = 24 * 3600 * 1000 }) {
  let cached = null;
  let lastChecked = 0;
  let inflight = null;

  async function check(force = false) {
    if (!force && cached && Date.now() - lastChecked < intervalMs) return cached;
    if (!inflight) {
      inflight = checkUpdate({ repo, current, fetch }).then(r => {
        cached = r;
        lastChecked = Date.now();
        return r;
      }).finally(() => { inflight = null; });
    }
    return inflight;
  }

  function startBackground() {
    check(false).catch(() => {});
    const t = setInterval(() => { check(true).catch(() => {}); }, intervalMs);
    t.unref?.();
    return t;
  }

  return { check, startBackground };
}

module.exports = { compareVersions, checkUpdate, applyUpdate, createUpdateService };
