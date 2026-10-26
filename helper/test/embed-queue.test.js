'use strict';
// The queue puts the written subtitles into the MP4 when the job asks for it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.REELHEIST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-embedq-'));

const muxMod = require('../lib/mux');
muxMod.mux = async (streams, outFile) => { await fs.promises.writeFile(outFile, Buffer.alloc(2048, 0xaa)); };
const calls = [];
let embedResult = async () => 2;
muxMod.embedSubtitles = async (...args) => { calls.push(args); return embedResult(...args); };

const { Queue } = require('../lib/jobs');
const { startHlsServer } = require('./fixtures/hls-server');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nMerhaba\n';

async function withServers(fn) {
  const hls = await startHlsServer({ segments: 2, delayMs: 5 });
  const subs = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/vtt' }); res.end(VTT); }).listen(0, '127.0.0.1');
  await new Promise(r => subs.on('listening', r));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-embedq-out-'));
  try {
    await fn({ hls, subBase: `http://127.0.0.1:${subs.address().port}`, outDir });
  } finally {
    await hls.close();
    subs.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

async function runJob(q, input) {
  const { job } = await q.add(input);
  for (let i = 0; i < 100 && !['done', 'failed'].includes(q.get(job.id).state); i++) await sleep(50);
  return q.get(job.id);
}

const input = (hls, subBase, extra = {}) => ({
  meta: { kind: 'episode', name: 'Show', season: 1, episode: 1 },
  source: { kind: 'hls', url: hls.mediaUrl, headers: {} },
  subtitles: [
    { url: `${subBase}/x_subtitles02.tur.forced.vtt`, label: 'Forced' },
    { url: `${subBase}/x_subtitles03.tur.vtt`, label: 'Turkish' },
  ],
  includeHlsSubtitles: false,
  ...extra,
});

test('a job with embedSubs gives the written subtitles and the default language to embedSubtitles', async () => {
  calls.length = 0;
  embedResult = async () => 2;
  await withServers(async ({ hls, subBase, outDir }) => {
    const q = new Queue({ notify: () => {} });
    q.jobs = [];
    await q.setSettings({ outDir, lang: 'tr' });
    const job = await runJob(q, input(hls, subBase, { embedSubs: { lang: 'tr' } }));
    assert.strictEqual(job.state, 'done', job.error);
    assert.strictEqual(calls.length, 1);
    const [video, subs, opts] = calls[0];
    assert.strictEqual(video, job.output.video);
    // Every episode has its own folder; its .srt files are in an "srt" folder inside it.
    assert.strictEqual(path.dirname(video), path.join(outDir, 'Show', 'Show.S01E01'));
    assert.ok(subs.every(s => path.dirname(s.file) === path.join(path.dirname(video), 'srt')));
    assert.ok(subs.every(s => fs.existsSync(s.file)), 'keepSrt is on by default');
    assert.deepStrictEqual(subs.map(s => [path.basename(s.file), s.lang, s.forced]),
      [['Show.S01E01.tr.forced.srt', 'tr', true], ['Show.S01E01.tr.srt', 'tr', false]]);
    assert.deepStrictEqual({ defaultLang: opts.defaultLang, uiLang: opts.uiLang }, { defaultLang: 'tr', uiLang: 'tr' });
    assert.strictEqual(job.output.embeddedSubs, 2);
    assert.strictEqual(job.warning, null);
  });
});

test('when embedding fails the MP4 stays and the card gets a warning', async () => {
  calls.length = 0;
  embedResult = async () => { throw new Error('ffmpeg hata kodu 1'); };
  await withServers(async ({ hls, subBase, outDir }) => {
    const q = new Queue({ notify: () => {} });
    q.jobs = [];
    await q.setSettings({ outDir });
    const job = await runJob(q, input(hls, subBase, { embedSubs: { lang: 'tr' } }));
    assert.strictEqual(job.state, 'done', job.error);
    assert.strictEqual(job.warning, 'subs_not_embedded');
    assert.ok(fs.existsSync(job.output.video));
    assert.strictEqual(job.output.embeddedSubs, 0);
  });
});

test('a job without embedSubs does not embed', async () => {
  calls.length = 0;
  await withServers(async ({ hls, subBase, outDir }) => {
    const q = new Queue({ notify: () => {} });
    q.jobs = [];
    await q.setSettings({ outDir });
    const job = await runJob(q, input(hls, subBase));
    assert.strictEqual(job.state, 'done', job.error);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(job.output.embeddedSubs, 0);
  });
});

test('add and addResolving keep only a language code in embedSubs', async () => {
  const q = new Queue({ notify: () => {} });
  q.jobs = [];
  const a = await q.add({ meta: { kind: 'movie', name: 'M' }, source: { kind: 'hls', url: 'http://127.0.0.1:9/x.m3u8' },
    embedSubs: { lang: 'tr', extra: 'x' } });
  assert.deepStrictEqual(a.job.embedSubs, { lang: 'tr', keepSrt: true });
  await q.cancel(a.job.id);
  const b = await q.add({ state: 'resolving', pageUrl: 'https://s.test/e1', meta: { kind: 'episode', name: 'S', season: 1, episode: 1 },
    group: { key: 'S/S1', name: 'S', season: 1, count: 1 }, embedSubs: { lang: '' } });
  assert.deepStrictEqual(b.job.embedSubs, { lang: '', keepSrt: true });
  const c = await q.add({ state: 'resolving', pageUrl: 'https://s.test/e2', meta: { kind: 'episode', name: 'S', season: 1, episode: 2 },
    group: { key: 'S/S1', name: 'S', season: 1, count: 2 } });
  assert.strictEqual(c.job.embedSubs, null);
});

test('keepSrt off: the .srt files and their folder go once the subtitles are inside the MP4', async () => {
  calls.length = 0;
  embedResult = async () => 2;
  await withServers(async ({ hls, subBase, outDir }) => {
    const q = new Queue({ notify: () => {} });
    q.jobs = [];
    await q.setSettings({ outDir });
    const job = await runJob(q, input(hls, subBase, { embedSubs: { lang: 'tr', keepSrt: false } }));
    assert.strictEqual(job.state, 'done', job.error);
    const dir = path.dirname(job.output.video);
    assert.deepStrictEqual(fs.readdirSync(dir), ['Show.S01E01.mp4']);
    assert.strictEqual(job.output.srtKept, false);
  });
});

test('keepSrt off but embedding failed: the .srt files stay', async () => {
  calls.length = 0;
  embedResult = async () => { throw new Error('ffmpeg hata kodu 1'); };
  await withServers(async ({ hls, subBase, outDir }) => {
    const q = new Queue({ notify: () => {} });
    q.jobs = [];
    await q.setSettings({ outDir });
    const job = await runJob(q, input(hls, subBase, { embedSubs: { lang: 'tr', keepSrt: false } }));
    assert.strictEqual(job.warning, 'subs_not_embedded');
    assert.deepStrictEqual(fs.readdirSync(path.join(path.dirname(job.output.video), 'srt')).sort(),
      ['Show.S01E01.tr.forced.srt', 'Show.S01E01.tr.srt']);
    assert.strictEqual(job.output.srtKept, true);
  });
});

test('embedSubs keeps keepSrt; it is on unless the extension says false', async () => {
  const q = new Queue({ notify: () => {} });
  q.jobs = [];
  const mk = async (n, embedSubs) => (await q.add({ state: 'resolving', pageUrl: `https://s.test/k${n}`,
    meta: { kind: 'episode', name: 'S', season: 1, episode: n }, group: { key: 'S/S1', name: 'S', season: 1, count: 3 }, embedSubs })).job.embedSubs;
  assert.deepStrictEqual(await mk(1, { lang: 'tr' }), { lang: 'tr', keepSrt: true });
  assert.deepStrictEqual(await mk(2, { lang: 'tr', keepSrt: false }), { lang: 'tr', keepSrt: false });
  assert.deepStrictEqual(await mk(3, { lang: 'tr', keepSrt: 'no' }), { lang: 'tr', keepSrt: true });
});
