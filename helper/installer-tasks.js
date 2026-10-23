'use strict';
// Post-install and pre-uninstall helper tasks invoked by the Inno Setup installer.
// Usage:
//   node helper/installer-tasks.js install <appDir>
//   node helper/installer-tasks.js shutdown

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const P = require('./lib/paths');
const { migrateLegacy } = require('./lib/migrate');

const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const LEGACY_DIR = path.join(LOCALAPPDATA, 'DiziIndirici');
const DEPS_CACHE_DIR = path.join(os.tmpdir(), 'reelheist-deps-cache');
const HOST_NAME = 'com.reelheist.helper';

function curlGet(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync('curl.exe', ['-sSL', '--ssl-no-revoke', '--fail', '-o', dest, url], { windowsHide: true });
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex').toLowerCase();
}

function parseChecksum(text, filename) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m && path.basename(m[2].trim()) === filename) return m[1].toLowerCase();
  }
  return null;
}

async function ensureFfmpeg() {
  const ffmpegDir = path.join(P.DATA_DIR, 'ffmpeg');
  const ffmpegExe = P.FFMPEG_EXE || path.join(ffmpegDir, 'bin', 'ffmpeg.exe');
  if (fs.existsSync(ffmpegExe)) return;

  for (const cand of [path.join(LEGACY_DIR, 'ffmpeg'), path.join(DEPS_CACHE_DIR, 'ffmpeg')]) {
    if (fs.existsSync(path.join(cand, 'bin', 'ffmpeg.exe'))) {
      await fsp.cp(cand, ffmpegDir, { recursive: true });
      return;
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-ffmpeg-'));
  try {
    const zipName = 'ffmpeg-master-latest-win64-gpl.zip';
    const baseUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
    const sumsPath = path.join(tmpDir, 'checksums.sha256');
    const zipPath = path.join(tmpDir, zipName);

    curlGet(`${baseUrl}/checksums.sha256`, sumsPath);
    curlGet(`${baseUrl}/${zipName}`, zipPath);

    const expected = parseChecksum(fs.readFileSync(sumsPath, 'utf8'), zipName);
    if (expected) {
      const actual = sha256File(zipPath);
      if (actual !== expected) throw new Error(`ffmpeg SHA-256 mismatch: expected ${expected}, got ${actual}`);
    }

    const extractDir = path.join(tmpDir, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync('tar.exe', ['-xf', zipPath, '-C', extractDir], { windowsHide: true });
    const entries = fs.readdirSync(extractDir, { withFileTypes: true }).filter(e => e.isDirectory());
    if (!entries.length) throw new Error('ffmpeg archive had no root folder');
    await fsp.rm(ffmpegDir, { recursive: true, force: true });
    await fsp.cp(path.join(extractDir, entries[0].name), ffmpegDir, { recursive: true });
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function ensureYtdlp() {
  const ytdlpExe = path.join(P.YTDLP_DIR, 'yt-dlp.exe');
  if (fs.existsSync(ytdlpExe)) return;

  for (const cand of [path.join(LEGACY_DIR, 'yt-dlp', 'yt-dlp.exe'), path.join(DEPS_CACHE_DIR, 'yt-dlp', 'yt-dlp.exe')]) {
    if (fs.existsSync(cand)) {
      await fsp.mkdir(P.YTDLP_DIR, { recursive: true });
      await fsp.copyFile(cand, ytdlpExe);
      return;
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-ytdlp-'));
  try {
    const baseUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
    const sumsPath = path.join(tmpDir, 'SHA2-256SUMS');
    const exePath = path.join(tmpDir, 'yt-dlp.exe');

    curlGet(`${baseUrl}/SHA2-256SUMS`, sumsPath);
    curlGet(`${baseUrl}/yt-dlp.exe`, exePath);

    const expected = parseChecksum(fs.readFileSync(sumsPath, 'utf8'), 'yt-dlp.exe');
    if (expected) {
      const actual = sha256File(exePath);
      if (actual !== expected) throw new Error(`yt-dlp SHA-256 mismatch: expected ${expected}, got ${actual}`);
    }

    await fsp.mkdir(P.YTDLP_DIR, { recursive: true });
    await fsp.copyFile(exePath, ytdlpExe);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function stopRunningDaemon() {
  try {
    const info = JSON.parse(fs.readFileSync(P.DAEMON_INFO, 'utf8'));
    if (info?.port && info?.token) {
      await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, {
        method: 'POST',
        headers: { 'X-Token': info.token },
        signal: AbortSignal.timeout(2000),
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 400));
    }
  } catch { /* not running */ }
}

function startDaemonOutsideJob(nodeExe, daemonScript) {
  const cwd = path.dirname(daemonScript);
  const cmdLine = `"${nodeExe}" "${daemonScript}"`.replace(/'/g, "''");
  const ps = [
    '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0};',
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${cmdLine}'; CurrentDirectory='${cwd.replace(/'/g, "''")}'; ProcessStartupInformation=$si};`,
    'if ($r.ReturnValue -ne 0) { exit 1 }',
  ].join(' ');
  return new Promise(resolve => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      windowsHide: true,
      stdio: 'ignore',
    });
    p.on('close', code => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

async function runInstall(appDir) {
  const resolvedApp = path.resolve(appDir || path.join(__dirname, '..'));
  await fsp.mkdir(P.DATA_DIR, { recursive: true });

  // 1. Migrate legacy DiziIndirici folder (one-time copy)
  await migrateLegacy({ legacyDir: LEGACY_DIR, dataDir: P.DATA_DIR }).catch(e => {
    console.warn('Migration warning:', e.message);
  });

  // 2. Ensure ffmpeg and yt-dlp (warn and continue on failure)
  await ensureFfmpeg().catch(e => console.warn('ffmpeg download warning:', e.message));
  await ensureYtdlp().catch(e => console.warn('yt-dlp download warning:', e.message));

  // 3. Write BOM-less native messaging manifest pointing to <appDir>\host.cmd
  const extIdCandidates = [
    path.join(resolvedApp, 'keys', 'extension-id.txt'),
    path.join(resolvedApp, '..', 'keys', 'extension-id.txt'),
  ];
  let extId = 'eajmalibibphcidgjgafefonphecbhgo';
  for (const c of extIdCandidates) {
    if (fs.existsSync(c)) {
      extId = fs.readFileSync(c, 'utf8').trim() || extId;
      break;
    }
  }

  const hostCmdPath = path.join(resolvedApp, 'host.cmd');
  const manifest = {
    name: HOST_NAME,
    description: 'ReelHeist helper',
    path: hostCmdPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extId}/`],
  };
  const manifestPath = path.join(P.DATA_DIR, `${HOST_NAME}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8' });

  try { fs.rmSync(path.join(LEGACY_DIR, 'com.dizi_indirici.helper.json'), { force: true }); } catch {}

  // 4. Restart daemon from installed app outside the installer's job object so guide.url is written
  await stopRunningDaemon();
  const daemonScript = path.join(resolvedApp, 'helper', 'daemon.js');
  if (fs.existsSync(daemonScript)) {
    await startDaemonOutsideJob(process.execPath, daemonScript);
    const guideUrlFile = path.join(resolvedApp, 'guide.url');
    for (let i = 0; i < 20; i++) {
      if (fs.existsSync(guideUrlFile)) break;
      await new Promise(r => setTimeout(r, 150));
    }
  }
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'install') {
    await runInstall(arg);
  } else if (cmd === 'shutdown') {
    await stopRunningDaemon();
  } else {
    console.error('Usage: installer-tasks.js <install|shutdown> [appDir]');
    process.exit(1);
  }
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
