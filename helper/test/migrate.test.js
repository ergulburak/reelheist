'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateLegacy } = require('../lib/migrate');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-migrate-'));
  const legacyDir = path.join(base, 'Legacy');
  const dataDir = path.join(base, 'New');
  fs.mkdirSync(path.join(legacyDir, 'ffmpeg', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(legacyDir, 'yt-dlp'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'settings.json'), '{"outDir":"X"}');
  fs.writeFileSync(path.join(legacyDir, 'jobs.json'), JSON.stringify([
    { id: 'a', state: 'downloading' }, { id: 'b', state: 'muxing' }, { id: 'c', state: 'done' },
  ]));
  fs.writeFileSync(path.join(legacyDir, 'ffmpeg', 'bin', 'ffmpeg.exe'), 'fake');
  fs.writeFileSync(path.join(legacyDir, 'yt-dlp', 'yt-dlp.exe'), 'fake');
  fs.writeFileSync(path.join(legacyDir, 'yt-cookies.txt'), 'cookies');
  fs.writeFileSync(path.join(legacyDir, 'daemon.json'), JSON.stringify({ port: 1, token: 't' }));
  return { base, legacyDir, dataDir };
}

test('migrates settings, jobs, ffmpeg, yt-dlp once', async () => {
  const { legacyDir, dataDir } = setup();
  const r = await migrateLegacy({ legacyDir, dataDir, shutdown: async () => {} });
  assert.strictEqual(r.migrated, true);
  assert.ok(fs.existsSync(path.join(dataDir, 'settings.json')));
  assert.ok(fs.existsSync(path.join(dataDir, 'jobs.json')));
  assert.ok(fs.existsSync(path.join(dataDir, 'ffmpeg', 'bin', 'ffmpeg.exe')));
  assert.ok(fs.existsSync(path.join(dataDir, 'yt-dlp', 'yt-dlp.exe')));
  assert.ok(!fs.existsSync(path.join(dataDir, 'yt-cookies.txt')));
  assert.ok(!fs.existsSync(path.join(dataDir, 'daemon.json')));
  assert.ok(fs.existsSync(path.join(legacyDir, 'MIGRATED.txt')));
  assert.ok(fs.existsSync(path.join(legacyDir, 'jobs.json')), 'legacy stays');
  const jobs = JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs.json'), 'utf8'));
  assert.deepStrictEqual(jobs.map(j => j.state), ['queued', 'queued', 'done']);
  assert.ok(!fs.readdirSync(dataDir).some(n => n.endsWith('.tmp')));
});

test('second run is a no-op', async () => {
  const { legacyDir, dataDir } = setup();
  await migrateLegacy({ legacyDir, dataDir, shutdown: async () => {} });
  const r = await migrateLegacy({ legacyDir, dataDir, shutdown: async () => {} });
  assert.strictEqual(r.migrated, false);
  assert.deepStrictEqual(r.moved, []);
});

test('missing legacy dir is a no-op', async () => {
  const { base, dataDir } = setup();
  const r = await migrateLegacy({ legacyDir: path.join(base, 'nope'), dataDir });
  assert.deepStrictEqual(r, { migrated: false, moved: [] });
});

test('shuts down a running legacy daemon first', async () => {
  const { legacyDir, dataDir } = setup();
  const calls = [];
  await migrateLegacy({
    legacyDir, dataDir,
    shutdown: async info => {
      calls.push(['shutdown', info.port, info.token, fs.existsSync(path.join(dataDir, 'jobs.json'))]);
    },
  });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], ['shutdown', 1, 't', false]);
});

test('does not overwrite existing new data', async () => {
  const { legacyDir, dataDir } = setup();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'jobs.json'), '["mine"]');
  const r = await migrateLegacy({ legacyDir, dataDir, shutdown: async () => {} });
  assert.strictEqual(fs.readFileSync(path.join(dataDir, 'jobs.json'), 'utf8'), '["mine"]');
  assert.ok(!r.moved.includes('jobs.json'));
  assert.ok(r.moved.includes('settings.json'));
});
