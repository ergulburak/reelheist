'use strict';
// Subtitle-only jobs: no video download, no ffmpeg, only <base>.<lang>.srt files.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.REELHEIST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-subsonly-'));
const { Queue } = require('../lib/jobs');
const { planHlsSubtitles } = require('../lib/download');
const { subtitleArgs } = require('../lib/ytdlp');

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nMerhaba\n';

async function serve(routes) {
  const srv = http.createServer((req, res) => {
    const body = routes[req.url.split('?')[0]];
    if (body === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(body);
  }).listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One queue for the whole file: a second load() would pick up jobs the earlier tests left behind.
let shared = null;
async function queue() {
  if (!shared) { shared = new Queue({ notify: () => {} }); await shared.load(); }
  return shared;
}
async function finish(q, id) {
  for (let i = 0; i < 100 && !['done', 'failed'].includes(q.get(id).state); i++) await sleep(50);
  return q.get(id);
}

test('subtitlesOnly job writes srt files and no mp4', async () => {
  const srv = await serve({ '/tr.vtt': VTT, '/en.vtt': VTT });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-subsonly-out-'));
  const q = await queue();
  await q.setSettings({ outDir });
  try {
    const { job } = await q.add({
      meta: { kind: 'episode', name: 'Show', season: 1, episode: 2 },
      source: { kind: 'hls', url: `${srv.base}/never-fetched.m3u8` },
      subtitles: [{ url: `${srv.base}/tr.vtt`, lang: 'tr' }, { url: `${srv.base}/en.vtt`, lang: 'en' }],
      subtitlesOnly: true,
    });
    assert.strictEqual(job.subtitlesOnly, true);
    const j = await finish(q, job.id);
    assert.strictEqual(j.state, 'done', j.error);
    assert.strictEqual(j.step, 'done');
    assert.strictEqual(j.output.video, null);
    assert.deepStrictEqual(j.output.subtitles.map(s => s.lang).sort(), ['en', 'tr']);
    // The episode's own folder holds its subtitles.
    const files = fs.readdirSync(path.join(outDir, 'Show', 'Show.S01E02', 'srt')).sort();
    assert.deepStrictEqual(files, ['Show.S01E02.en.srt', 'Show.S01E02.tr.srt']);
    assert.match(fs.readFileSync(path.join(outDir, 'Show', 'Show.S01E02', 'srt', 'Show.S01E02.tr.srt'), 'utf8'), /Merhaba/);
  } finally {
    srv.close();
  }
});

test('subtitlesOnly job without any subtitle fails with no_subtitles', async () => {
  const srv = await serve({});
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-subsonly-out-'));
  const q = await queue();
  await q.setSettings({ outDir });
  try {
    const { job } = await q.add({
      meta: { kind: 'movie', name: 'Film', year: 2026 },
      source: { kind: 'hls', url: `${srv.base}/missing.m3u8` },
      subtitles: [{ url: `${srv.base}/missing.vtt`, lang: 'tr' }],
      subtitlesOnly: true,
    });
    const j = await finish(q, job.id);
    assert.strictEqual(j.state, 'failed');
    assert.strictEqual(j.errorCode, 'no_subtitles');
    assert.ok(!fs.existsSync(path.join(outDir, 'Film (2026)', 'Film (2026).mp4')));
  } finally {
    srv.close();
  }
});

test('planHlsSubtitles reads subtitle renditions from a cached master playlist', async () => {
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Türkçe",LANGUAGE="tr",URI="subs/tr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,SUBTITLES="subs"
480/index.m3u8
`;
  const url = 'https://x.test/hls/master.m3u8';
  const job = { source: { url, headers: {} }, playlists: { [url]: master }, includeHlsSubtitles: true };
  const subs = await planHlsSubtitles(job);
  assert.deepStrictEqual(subs.map(s => [s.url, s.lang, s.label, s.hls]), [['https://x.test/hls/subs/tr.m3u8', 'tr', 'Türkçe', true]]);
  const media = { source: { url, headers: {} }, playlists: { [url]: '#EXTM3U\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n' } };
  assert.deepStrictEqual(await planHlsSubtitles(media), []);
});

test('subtitlesOnly done notification uses its own key', async () => {
  const calls = [];
  const q = new Queue({ notify: c => calls.push(c) });
  await q.load();
  q.onDone({ subtitlesOnly: true, names: { base: 'Show.S01E02' }, output: { video: null, size: 0, subtitles: [{}, {}] }, group: null });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].key, 'notify_done_subs_only');
  assert.strictEqual(calls[0].vars.n, 2);
});

test('yt-dlp subtitle-only arguments skip the video', () => {
  const args = subtitleArgs([{ lang: 'tr' }, { lang: 'en', auto: true }]);
  assert.ok(args.includes('--sub-langs') && args[args.indexOf('--sub-langs') + 1] === 'tr,en');
  assert.ok(args.includes('--write-subs') && args.includes('--write-auto-subs'));
  assert.ok(args.includes('--convert-subs'));
  assert.ok(!args.includes('-f') && !args.includes('--skip-download'));
});

test('concurrent saves do not race on the temp file', async () => {
  const q = await queue();
  q.jobs = [{ id: 'x', state: 'done' }];
  await Promise.all([q.save(), q.save(), q.save(), q.save()]);
  const { JOBS_FILE } = require('../lib/paths');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).map(j => j.id), ['x']);
});
