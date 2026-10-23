'use strict';
// Native messaging host. The browser starts it for each message; it makes sure the
// download daemon runs and replies with the daemon's port and token.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const P = require('./lib/paths');

function readMessage() {
  return new Promise(resolve => {
    let buf = Buffer.alloc(0);
    process.stdin.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length >= 4 + len) {
          try { resolve(JSON.parse(buf.subarray(4, 4 + len).toString('utf8'))); } catch { resolve({}); }
        }
      }
    });
    process.stdin.on('end', () => resolve({}));
  });
}

function writeMessage(obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length, 0);
  return new Promise(r => process.stdout.write(Buffer.concat([len, data]), r));
}

function readInfo() {
  try { return JSON.parse(fs.readFileSync(P.DAEMON_INFO, 'utf8')); } catch { return null; }
}

async function ping(info) {
  if (!info) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/ping`, {
      headers: { 'X-Token': info.token },
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Start the daemon outside the browser's job object (WMI), so it keeps running after
// this host process exits and even after the browser closes.
function startDaemon() {
  const node = process.execPath;
  const script = path.join(__dirname, 'daemon.js');
  const cmdLine = `"${node}" "${script}"`.replace(/'/g, "''");
  const ps = [
    "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0};",
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${cmdLine}'; CurrentDirectory='${__dirname.replace(/'/g, "''")}'; ProcessStartupInformation=$si};`,
    'if ($r.ReturnValue -ne 0) { exit 1 }',
  ].join(' ');
  return new Promise(resolve => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      windowsHide: true,
      stdio: 'ignore',
    });
    p.on('close', code => resolve(code === 0));
    p.on('error', () => resolve(false));
  }).then(ok => {
    if (ok) return;
    // Fallback: plain detached spawn.
    spawn(node, [script], { detached: true, stdio: 'ignore', windowsHide: true, cwd: __dirname }).unref();
  });
}

// Only one host may start the daemon; others wait for it (the browser often sends
// several messages at once).
function takeLock() {
  const lock = path.join(P.DATA_DIR, 'start.lock');
  try {
    fs.mkdirSync(P.DATA_DIR, { recursive: true });
    const fd = fs.openSync(lock, 'wx');
    fs.closeSync(fd);
    return () => fs.rmSync(lock, { force: true });
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 15000) {
        fs.rmSync(lock, { force: true });
        return takeLock();
      }
    } catch { /* lock vanished: retry below */ }
    return null;
  }
}

async function ensureDaemon() {
  let info = readInfo();
  if (await ping(info)) return info;
  const before = info?.startedAt || 0;
  const release = takeLock();
  try {
    if (release) await startDaemon().catch(() => {});
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      info = readInfo();
      if (info && info.startedAt > before && (await ping(info))) return info;
    }
    throw new Error('The helper daemon did not start');
  } finally {
    release?.();
  }
}

(async () => {
  const msg = await readMessage();
  try {
    const info = await ensureDaemon();
    if (!msg.cmd || msg.cmd === 'hello') {
      await fetch(`http://127.0.0.1:${info.port}/api/ping?hello=1`, {
        headers: { 'X-Token': info.token },
        signal: AbortSignal.timeout(1500),
      }).catch(() => {});
    }
    await writeMessage({ ok: true, port: info.port, token: info.token, version: info.version, cmd: msg.cmd || 'hello' });
  } catch (e) {
    await writeMessage({ ok: false, error: e.message });
  }
  process.exit(0);
})();
