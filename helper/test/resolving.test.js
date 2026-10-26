'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-resolving-'));
process.env.REELHEIST_DATA = DATA;

const P = require('../lib/paths');
const muxMod = require('../lib/mux');
muxMod.mux = async (streams, outFile) => {
  await fs.promises.writeFile(outFile, Buffer.alloc(2048, 0xaa));
};

const { Queue } = require('../lib/jobs');
const { startHlsServer } = require('./fixtures/hls-server');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const input = (n = 1) => ({
  state: 'resolving',
  pageUrl: `https://s.test/e${n}`,
  meta: { kind: 'episode', name: 'Show', season: 1, episode: n },
  group: { key: 'Show/S1', name: 'Show', season: 1, count: 2 },
});

async function fresh() {
  const q = new Queue({ notify: () => {} });
  q.jobs = [];
  await q.save();
  return q;
}

test('add resolving job without source', async () => {
  const q = await fresh();
  const { job, reused, skipped } = await q.add(input());
  assert.strictEqual(job.state, 'resolving');
  assert.strictEqual(job.step, 'page');
  assert.strictEqual(job.source.url, null);
  assert.strictEqual(job.resolve.attempts, 0);
  assert.strictEqual(reused, false);
  assert.strictEqual(skipped, false);
  const saved = JSON.parse(fs.readFileSync(P.JOBS_FILE, 'utf8'));
  assert.ok(saved.some(j => j.id === job.id));
});

test('add dedups by pageUrl', async () => {
  const q = await fresh();
  const a = await q.add(input());
  const b = await q.add(input());
  assert.strictEqual(b.reused, true);
  assert.strictEqual(b.job.id, a.job.id);
  assert.strictEqual(q.jobs.length, 1);
});

test('add reuses a failed job', async () => {
  const q = await fresh();
  const { job } = await q.add(input());
  await q.fail(job.id, { code: 'episode_timeout', detail: 'x', step: 'video' });
  assert.strictEqual(q.get(job.id).state, 'failed');
  const r = await q.add(input());
  assert.strictEqual(r.reused, true);
  assert.strictEqual(r.job.state, 'resolving');
  assert.strictEqual(r.job.error, null);
  assert.strictEqual(r.job.stepError, null);
});

test('add skips a done job', async () => {
  const q = await fresh();
  const { job } = await q.add(input());
  job.state = 'done';
  const r = await q.add(input());
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.job.state, 'done');
  assert.strictEqual(q.jobs.length, 1);
});

test('resolveUpdate writes steps and rejects other states', async () => {
  const q = await fresh();
  const { job } = await q.add(input());
  await q.resolveUpdate(job.id, { step: 'video', startedAt: 1000, deadlineMs: 90000, note: 'waiting_player' });
  assert.strictEqual(job.step, 'video');
  assert.strictEqual(job.resolve.startedAt, 1000);
  assert.strictEqual(job.resolve.deadlineMs, 90000);
  assert.strictEqual(job.resolve.note, 'waiting_player');
  job.state = 'queued';
  await assert.rejects(q.resolveUpdate(job.id, { step: 'video' }), e => e.code === 'state');
});

test('resolved queues the job', async () => {
  const srv = await startHlsServer({ segments: 3, delayMs: 20 });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-resolving-out-'));
  try {
    const q = await fresh();
    await q.setSettings({ outDir });
    const { job } = await q.add(input());
    await q.resolved(job.id, { source: { kind: 'hls', url: srv.mediaUrl, headers: {} }, playlists: null, subtitles: [] });
    assert.ok(['queued', 'downloading', 'muxing', 'done'].includes(job.state), job.state);
    assert.ok(['download', 'mux', 'done'].includes(job.step), job.step);
    assert.strictEqual(job.source.url, srv.mediaUrl);
    for (let i = 0; i < 60 && q.get(job.id).state !== 'done'; i++) await sleep(100);
    assert.strictEqual(q.get(job.id).state, 'done');
    assert.strictEqual(q.get(job.id).step, 'done');
  } finally {
    await srv.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('resolved rejects non-resolving', async () => {
  const q = await fresh();
  const { job } = await q.add(input());
  await q.cancel(job.id);
  await assert.rejects(
    q.resolved(job.id, { source: { kind: 'hls', url: 'http://127.0.0.1:9/x.m3u8', headers: {} }, playlists: null, subtitles: [] }),
    e => e.code === 'state');
  assert.strictEqual(q.get(job.id).state, 'canceled');
});

test('retry on video failure returns resolve:true', async () => {
  const q = await fresh();
  const { job } = await q.add(input());
  await q.resolveUpdate(job.id, { attempts: 2 });
  await q.fail(job.id, { code: 'episode_timeout', detail: 'x', step: 'video' });
  const r = await q.retry(job.id);
  assert.strictEqual(r.resolve, true);
  assert.strictEqual(r.job.state, 'resolving');
  assert.strictEqual(r.job.resolve.attempts, 0);
  assert.strictEqual(r.job.step, 'page');
});

test('fail maps unknown codes to internal', async () => {
  const q = await fresh();
  const { job } = await q.add(input());
  await q.fail(job.id, { code: 'nope', detail: 'x', step: 'page' });
  assert.strictEqual(job.errorCode, 'internal');
  assert.strictEqual(job.stepError, 'page');
});

test('watchdog fails stale resolving jobs', async () => {
  const { q, calls } = spyQueue('errors');
  const a = (await q.add(input(1))).job;
  const b = (await q.add(input(2))).job;
  const c = (await q.add(input(3))).job;
  await q.resolveUpdate(a.id, { startedAt: 0, deadlineMs: 90000 });
  // c started as long ago as a, but its resolver sent a heartbeat inside the window.
  await q.resolveUpdate(c.id, { startedAt: 0, deadlineMs: 90000, heartbeat: 150000 });
  assert.strictEqual(c.resolve.heartbeat, 150000);
  assert.strictEqual(q.tickWatchdog(200000), 1);
  assert.strictEqual(a.state, 'failed');
  assert.strictEqual(a.errorCode, 'episode_interrupted');
  assert.strictEqual(a.stepError, 'video');
  assert.strictEqual(b.state, 'resolving');
  assert.strictEqual(c.state, 'resolving');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].key, 'notify_failed');
  // Without new heartbeats, c goes stale too.
  assert.strictEqual(q.tickWatchdog(150000 + 90000 + 60001), 1);
  assert.strictEqual(c.state, 'failed');
});

test('load fails started resolving jobs only', async () => {
  const q0 = await fresh();
  const a = (await q0.add(input(1))).job;
  const b = (await q0.add(input(2))).job;
  a.resolve.startedAt = 1;
  await q0.save();
  const calls = [];
  const q = new Queue({ notify: n => { calls.push(n); } });
  await q.load();
  assert.strictEqual(q.get(a.id).state, 'failed');
  assert.strictEqual(q.get(a.id).errorCode, 'episode_interrupted');
  assert.strictEqual(q.get(b.id).state, 'resolving');
  assert.deepStrictEqual(calls.map(c => c.key), ['notify_failed']);
  clearInterval(q.watchdog);
});

test('kick() does not start a resolving job', async () => {
  const q = await fresh();
  const { job } = await q.add(input());
  q.kick();
  assert.strictEqual(q.running, null);
  assert.strictEqual(job.state, 'resolving');
});

test('retry on a resolving job leaves the attempt alone', async () => {
  const q = await fresh();
  const { job } = await q.add(input());
  await q.resolveUpdate(job.id, { startedAt: 5, attempts: 1, deadlineMs: 90000 });
  const r = await q.retry(job.id);
  assert.deepStrictEqual([r.resolve, r.job.state, r.job.resolve.startedAt, r.job.resolve.attempts], [true, 'resolving', 5, 1]);
});

test('resolved ignores meta for names', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-resolving-out-'));
  try {
    const q = await fresh();
    q.settings.outDir = outDir;
    const { job } = await q.add(input());
    const folder = job.names.folder;
    await q.resolved(job.id, {
      source: { kind: 'hls', url: 'http://127.0.0.1:9/x.m3u8', headers: {} }, playlists: null, subtitles: [],
      meta: { kind: 'episode', name: 'Other Show', season: 1, episode: 1 },
    });
    assert.strictEqual(job.names.folder, folder);
    assert.strictEqual(job.meta.name, 'Show');
    await q.cancel(job.id);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('retryResolve clears the old download and its work files', async () => {
  const q = await fresh();
  const { job } = await q.add(input());
  Object.assign(job, {
    state: 'failed', stepError: 'download', errorCode: 'link_expired', error: 'x', expired: true,
    progress: { phase: 'downloading', percent: 40 }, output: { video: 'v.mp4' },
    warning: 'av_mismatch', warningDetail: 'd', stats: { bytes: 1 },
    source: { kind: 'hls', url: 'http://127.0.0.1:9/x.m3u8', headers: {} },
  });
  const work = path.join(P.WORK_DIR, job.id);
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'x'), 'seg');
  await q.retryResolve(job.id);
  assert.strictEqual(job.state, 'resolving');
  assert.strictEqual(job.expired, false);
  for (const k of ['progress', 'output', 'warning', 'warningDetail', 'stats', 'error', 'errorCode']) assert.strictEqual(job[k], null, k);
  assert.ok(!fs.existsSync(work));
  await assert.rejects(q.retryResolve('nope'), e => e.code === 'bad_request');
});

test('retry on a canceled resolving job goes back to resolving', async () => {
  const q = await fresh();
  const { job } = await q.add(input());
  await q.cancel(job.id);
  const r = await q.retry(job.id);
  assert.strictEqual(r.resolve, true);
  assert.strictEqual(r.job.state, 'resolving');
  assert.strictEqual(r.job.stepError, null);
  assert.strictEqual(r.job.error, null);
});

test('season done notification', async () => {
  const calls = [];
  const mk = async (opts = {}) => {
    const q = new Queue({ notify: n => { calls.push(n); } });
    q.jobs = [];
    Object.assign(q.settings, opts);
    return q;
  };
  const finish = (q, j) => { j.state = 'done'; j.output = { size: 5e8, subtitles: [] }; q.onDone(j); };

  let q = await mk({ notify: 'all' });
  const a = (await q.add(input(1))).job;
  const b = (await q.add(input(2))).job;
  await q.fail(a.id, { code: 'episode_timeout', detail: 'late', step: 'video' });
  await q.remove(a.id);
  calls.length = 0;
  finish(q, b);
  assert.ok(calls.some(c => c.key === 'notify_season_done' && c.vars.n === 1 && c.vars.season === 1), JSON.stringify(calls));

  calls.length = 0;
  q = await mk({ notify: 'off' });
  const c = (await q.add(input(3))).job;
  finish(q, c);
  assert.strictEqual(calls.length, 0);
});

function spyQueue(mode) {
  const calls = [];
  const q = new Queue({ notify: n => { calls.push(n); } });
  q.jobs = [];
  q.settings.notify = mode;
  return { q, calls };
}
const plain = (extra = {}) => ({
  names: { base: 'Movie' },
  output: { size: 450e6, subtitles: [] },
  error: 'boom detail',
  ...extra,
});

test('onDone picks the toast key', () => {
  const { q, calls } = spyQueue('all');
  q.onDone(plain());
  assert.strictEqual(calls[0].key, 'notify_done');
  assert.strictEqual(calls[0].vars.name, 'Movie');
  assert.strictEqual(calls[0].vars.size, '450 MB');
  q.onDone(plain({ output: { size: 1e6, subtitles: ['a', 'b'] } }));
  assert.strictEqual(calls[1].key, 'notify_done_subs');
  assert.strictEqual(calls[1].vars.n, 2);
  q.onDone(plain({ warning: 'av_mismatch' }));
  assert.strictEqual(calls[2].key, 'notify_done_warn');
  assert.strictEqual(calls.length, 3);
});

test('onDone is silent unless notify is all', () => {
  for (const mode of ['errors', 'off']) {
    const { q, calls } = spyQueue(mode);
    q.onDone(plain());
    assert.strictEqual(calls.length, 0, mode);
  }
});

test('onFailed fires for all and errors, not off', () => {
  for (const mode of ['all', 'errors']) {
    const { q, calls } = spyQueue(mode);
    q.onFailed(plain());
    assert.strictEqual(calls.length, 1, mode);
    assert.strictEqual(calls[0].key, 'notify_failed');
    assert.strictEqual(calls[0].vars.error, 'boom detail');
    assert.strictEqual(calls[0].vars.name, 'Movie');
  }
  const { q, calls } = spyQueue('off');
  q.onFailed(plain());
  assert.strictEqual(calls.length, 0);
});

test('resolveUpdate resume note fires notify_resume', async () => {
  const { q, calls } = spyQueue('all');
  const { job } = await q.add(input(1));
  await q.resolveUpdate(job.id, { note: 'resume', remaining: 3 });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].key, 'notify_resume');
  assert.strictEqual(calls[0].vars.n, 3);
  const off = spyQueue('off');
  const j2 = (await off.q.add(input(2))).job;
  await off.q.resolveUpdate(j2.id, { note: 'resume', remaining: 3 });
  assert.strictEqual(off.calls.length, 0);
});

test('setSettings validates notify and lang', async () => {
  const q = new Queue({ notify: () => {} });
  await q.setSettings({ notify: 'bogus', lang: '../x' });
  assert.strictEqual(q.settings.notify, 'all');
  assert.strictEqual(q.settings.lang, 'en');
  await q.setSettings({ notify: 'errors', lang: 'tr' });
  assert.strictEqual(q.settings.notify, 'errors');
  assert.strictEqual(q.settings.lang, 'tr');
});

test('resolved without a source url is a bad request', async () => {
  const q = await fresh();
  const { job } = await q.add(input());
  await assert.rejects(q.resolved(job.id, {}), e => e.code === 'bad_request');
  await assert.rejects(q.resolved(job.id, { source: { kind: 'hls' } }), e => e.code === 'bad_request');
  assert.strictEqual(q.get(job.id).state, 'resolving');
});

test('fail records page or video as the failed step', async () => {
  const q = await fresh();
  const a = (await q.add(input(1))).job;
  await q.fail(a.id, { code: 'episode_timeout', detail: 'x' });
  assert.strictEqual(q.get(a.id).stepError, 'video');
  const b = (await q.add(input(2))).job;
  await q.fail(b.id, { code: 'episode_timeout', detail: 'x', step: 'download' });
  assert.strictEqual(q.get(b.id).stepError, 'video');
  const c = (await q.add(input(3))).job;
  await q.fail(c.id, { code: 'episode_timeout', detail: 'x', step: 'page' });
  assert.strictEqual(q.get(c.id).stepError, 'page');
});

test('resolveUpdate rejects an unknown step', async () => {
  const q = await fresh();
  const { job } = await q.add(input());
  await assert.rejects(q.resolveUpdate(job.id, { step: 'mux' }), e => e.code === 'bad_request');
  assert.strictEqual(q.get(job.id).step, 'page');
});

test('watchdog uses the default deadline when none was written', async () => {
  const q = await fresh();
  const { job } = await q.add(input());
  await q.resolveUpdate(job.id, { startedAt: 1000 });
  assert.strictEqual(q.get(job.id).resolve.deadlineMs, null);
  assert.strictEqual(q.tickWatchdog(1000 + 90000 + 60000 - 1), 0);
  assert.strictEqual(q.get(job.id).state, 'resolving');
  assert.strictEqual(q.tickWatchdog(1000 + 90000 + 60000 + 1), 1);
  assert.strictEqual(q.get(job.id).state, 'failed');
});

test('list() leaves out cached playlists and source headers', async () => {
  const q = await fresh();
  const { job } = await q.add(input());
  job.playlists = { 'https://x/a.m3u8': '#EXTM3U\n' };
  job.source = { kind: 'hls', url: 'https://x/a.m3u8', headers: { Cookie: 'secret' } };
  const [row] = JSON.parse(JSON.stringify(q.list()));
  assert.strictEqual(row.playlists, undefined);
  assert.deepStrictEqual(row.source, { kind: 'hls', url: 'https://x/a.m3u8' });
  assert.ok(job.playlists, 'the job itself keeps its playlists');
});

test('add reuses a paused or queued job of the same page', async () => {
  const q = await fresh();
  const { job } = await q.add(input());
  for (const state of ['paused', 'queued']) {
    job.state = state;
    const r = await q.add(input());
    assert.strictEqual(r.reused, true, state);
    assert.strictEqual(r.job.id, job.id);
    assert.strictEqual(r.job.state, state, 'the job is left as it is');
    assert.strictEqual(q.jobs.length, 1);
  }
});

test('a download failure records the download step; retry queues it again', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-resolving-out-'));
  const srv = require('http').createServer((req, res) => { res.writeHead(404); res.end(); }).listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/none.m3u8`;
  try {
    const q = await fresh();
    await q.setSettings({ outDir });
    const { job } = await q.add(input());
    await q.resolved(job.id, { source: { kind: 'hls', url, headers: {} } });
    for (let i = 0; i < 100 && q.get(job.id).state !== 'failed'; i++) await sleep(100);
    assert.strictEqual(q.get(job.id).state, 'failed');
    assert.strictEqual(q.get(job.id).stepError, 'download');
    const r = await q.retry(job.id);
    assert.strictEqual(r.resolve, false, 'the source is known: no new search');
    assert.ok(['queued', 'downloading', 'failed'].includes(r.job.state), r.job.state);
    await q.cancel(job.id);
  } finally {
    srv.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('resume toast counts the waiting episodes when the resolver sends no number', async () => {
  const { q, calls } = spyQueue('all');
  const a = (await q.add(input(1))).job;
  await q.add(input(2));
  await q.resolveUpdate(a.id, { note: 'resume' });
  assert.strictEqual(calls[0].key, 'notify_resume');
  assert.strictEqual(calls[0].vars.n, 2);
  assert.ok(!calls[0].body.includes('{n}'), calls[0].body);
});

test('failed toast shows the translated error text', () => {
  const { q, calls } = spyQueue('all');
  q.settings.lang = 'tr';
  q.onFailed(plain({ errorCode: 'episode_short' }));
  assert.match(calls[0].vars.error, /kısa/i);
  assert.ok(calls[0].body.includes(calls[0].vars.error));
});
