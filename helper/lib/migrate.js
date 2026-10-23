'use strict';
// One-time copy of the pre-rename data folder into the ReelHeist data folder.
// The legacy folder is never changed except for a MIGRATED.txt marker.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ITEMS = ['settings.json', 'jobs.json', 'ffmpeg', 'yt-dlp'];

const exists = p => fsp.access(p).then(() => true, () => false);

// Ask the legacy daemon to save its queue and exit. Failures are ignored.
async function defaultShutdown({ port, token }) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      headers: { 'X-Token': token },
      signal: AbortSignal.timeout(3000),
    });
    // The daemon exits ~100 ms after it answers; give it time to finish writing.
    if (r.ok) await new Promise(res => setTimeout(res, 800));
  } catch { /* not running */ }
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

async function migrateLegacy({ legacyDir, dataDir, shutdown = defaultShutdown }) {
  const marker = path.join(legacyDir, 'MIGRATED.txt');
  if (!(await exists(legacyDir)) || (await exists(marker))) return { migrated: false, moved: [] };

  const info = await readJson(path.join(legacyDir, 'daemon.json'));
  if (info && info.port && info.token) await shutdown(info);

  await fsp.mkdir(dataDir, { recursive: true });
  const moved = [];
  for (const name of ITEMS) {
    const src = path.join(legacyDir, name);
    const dest = path.join(dataDir, name);
    if (!(await exists(src)) || (await exists(dest))) continue;
    const tmp = dest + '.tmp';
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.cp(src, tmp, { recursive: true });
    if (name === 'jobs.json') {
      const jobs = await readJson(tmp);
      if (Array.isArray(jobs)) {
        for (const j of jobs) if (j && (j.state === 'downloading' || j.state === 'muxing')) j.state = 'queued';
        await fsp.writeFile(tmp, JSON.stringify(jobs, null, 1));
      }
    }
    await fsp.rename(tmp, dest);
    moved.push(name);
  }
  await fsp.writeFile(marker, `Copied to ${dataDir} on ${new Date().toISOString()}\n`);
  return { migrated: true, moved };
}

module.exports = { migrateLegacy };
