'use strict';
// Parallel downloads: up to settings.parallel jobs at once (default 3), first done first finished.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.REELHEIST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-parallel-'));

const muxMod = require('../lib/mux');
muxMod.mux = async (streams, outFile) => { await fs.promises.writeFile(outFile, Buffer.alloc(1024, 0xaa)); };

const { Queue, connectionCap } = require('../lib/jobs');
const { startHlsServer } = require('./fixtures/hls-server');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (fn()) return true; await sleep(20); }
  return false;
};
const running = q => q.jobs.filter(j => ['downloading', 'muxing'].includes(j.state)).length;

async function setup(t, { segments = 4, delayMs = 150, parallel } = {}) {
  const srv = await startHlsServer({ segments, delayMs });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-parallel-out-'));
  const q = new Queue({ notify: () => {} });
  q.jobs = [];
  await q.setSettings({ outDir, ...(parallel ? { parallel } : {}) });
  t.after(async () => {
    for (const j of q.jobs) await q.cancel(j.id).catch(() => {});
    await srv.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  });
  const add = n => q.add({ meta: { kind: 'episode', name: 'Show', season: 1, episode: n }, source: { kind: 'hls', url: srv.mediaUrl, headers: {} } });
  return { q, add };
}

test('default: three jobs download at once, the fourth waits', async t => {
  const { q, add } = await setup(t);
  assert.strictEqual(q.settings.parallel, 3);
  for (let n = 1; n <= 4; n++) await add(n);
  assert.ok(await until(() => running(q) === 3), `running ${running(q)}`);
  assert.strictEqual(q.jobs.filter(j => j.state === 'queued').length, 1);
  assert.ok(await until(() => q.jobs.every(j => j.state === 'done'), 15000), q.jobs.map(j => j.state).join(','));
  // The state turns 'done' inside the job; the running entry goes a moment later, in its finally.
  assert.ok(await until(() => q.running.size === 0), `running ${q.running.size}`);
});

test('parallel 1 runs one job at a time', async t => {
  const { q, add } = await setup(t, { parallel: 1 });
  let peak = 0;
  for (let n = 1; n <= 3; n++) await add(n);
  await until(() => { peak = Math.max(peak, running(q)); return q.jobs.every(j => j.state === 'done'); }, 15000);
  assert.strictEqual(peak, 1);
  assert.ok(q.jobs.every(j => j.state === 'done'));
});

test('raising the setting starts waiting jobs at once', async t => {
  const { q, add } = await setup(t, { parallel: 1, delayMs: 300 });
  for (let n = 1; n <= 3; n++) await add(n);
  assert.ok(await until(() => running(q) === 1));
  await q.setSettings({ parallel: 3 });
  assert.ok(await until(() => running(q) === 3, 2000), `running ${running(q)}`);
});

test('pausing one job lets the others go on and the next one start', async t => {
  const { q, add } = await setup(t, { delayMs: 300 });
  const ids = [];
  for (let n = 1; n <= 4; n++) ids.push((await add(n)).job.id);
  assert.ok(await until(() => running(q) === 3));
  const first = q.jobs.find(j => j.state === 'downloading');
  await q.pause(first.id);
  assert.strictEqual(q.get(first.id).state, 'paused');
  assert.ok(await until(() => running(q) === 3), 'the waiting job took the free place');
  assert.ok(q.jobs.filter(j => j.id !== first.id).every(j => ['downloading', 'muxing', 'done'].includes(j.state)));
});

test('setSettings accepts 1..5 only', async () => {
  const q = new Queue({ notify: () => {} });
  for (const bad of [0, 6, 2.5, '3', null]) {
    await q.setSettings({ parallel: bad });
    assert.strictEqual(q.settings.parallel, 3, String(bad));
  }
  await q.setSettings({ parallel: 5 });
  assert.strictEqual(q.settings.parallel, 5);
  await q.setSettings({ parallel: 3 });
});

test('connections are shared: 16 in all, at least 2 per job', () => {
  assert.deepStrictEqual([1, 2, 3, 4, 5].map(connectionCap), [16, 8, 5, 4, 3]);
});

test('a job downloads with its share of the connections', async t => {
  const { q, add } = await setup(t, { segments: 30, delayMs: 5 });
  const { job } = await add(1);
  assert.ok(await until(() => q.get(job.id).state === 'done', 15000));
  assert.strictEqual(q.get(job.id).stats.maxConnections, 5);
  assert.ok(q.get(job.id).stats.peakConnections <= 5);
});
