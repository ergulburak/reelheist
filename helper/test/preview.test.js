'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

// Find the real ffmpeg (before the data dir moves to a temp folder), then expose it through PATH.
const LOCAL = process.env.LOCALAPPDATA || '';
for (const app of ['ReelHeist', 'DiziIndirici']) {
  const dir = path.join(LOCAL, app, 'ffmpeg', 'bin');
  if (fs.existsSync(path.join(dir, 'ffmpeg.exe'))) { process.env.PATH = dir + path.delimiter + process.env.PATH; break; }
}
// Use a temp data dir before the modules read paths.js.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-preview-'));
process.env.REELHEIST_DATA = DATA;
const P = require('../lib/paths');
const preview = require('../lib/preview');
const { findFfmpeg } = require('../lib/mux');

test('picks segment containing 30%', () => {
  const segs = Array.from({ length: 10 }, () => ({ duration: 4 })); // 40 s, 30% = 12 s
  assert.deepStrictEqual(preview.pickPreviewSegment(segs), { index: 3, offsetSec: 0 });
  const segs2 = [{ duration: 5 }, { duration: 5 }, { duration: 10 }]; // 20 s, 30% = 6 s
  assert.deepStrictEqual(preview.pickPreviewSegment(segs2), { index: 1, offsetSec: 1 });
  assert.deepStrictEqual(preview.pickPreviewSegment([{ duration: 3 }]), { index: 0, offsetSec: 0.9 });
  assert.strictEqual(preview.pickPreviewSegment(segs, 1).index, 9);
});

test('args scale to 320 and drop audio', () => {
  const a = preview.previewArgs('in.ts', 1.5);
  assert.ok(a.includes('-an'));
  assert.strictEqual(a[a.indexOf('-vf') + 1], 'scale=320:-2,fps=24');
  assert.strictEqual(a[a.indexOf('-ss') + 1], '1.5');
  assert.ok(a.indexOf('-ss') > a.indexOf('-i'));
  assert.strictEqual(a[a.indexOf('-t') + 1], '2');
  assert.strictEqual(a[a.indexOf('-crf') + 1], '30');
  assert.strictEqual(a[a.indexOf('-preset') + 1], 'veryfast');
  assert.deepStrictEqual(a.slice(a.indexOf('-movflags'), a.indexOf('-movflags') + 4), ['-movflags', '+faststart', '-f', 'mp4']);
  assert.strictEqual(preview.previewArgs('in.ts', 0, 'out.mp4').at(-1), 'out.mp4');
  const r = preview.previewArgs('http://x/v.mp4', 468, 'o.mp4', { inputSeek: true, headers: "A: b" });
  assert.ok(r.indexOf('-ss') < r.indexOf('-i') && r.indexOf('-headers') < r.indexOf('-i'));
});

const ffmpeg = findFfmpeg();
const ffprobe = ffmpeg && path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const canRun = ffmpeg && fs.existsSync(ffprobe);

test('synthetic HLS -> mp4 under 400 KB with duration 2 +- 0.2 s, second call hits cache', { skip: !canRun }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-hls-'));
  const gen = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '20', '-c:v', 'libx264', '-g', '100', '-keyint_min', '100',
    '-sc_threshold', '0', '-c:a', 'aac', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
    '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(dir, 'seg%d.ts'), path.join(dir, 'high.m3u8')]);
  assert.strictEqual(gen.status, 0, String(gen.stderr).slice(-500));
  fs.copyFileSync(path.join(dir, 'high.m3u8'), path.join(dir, 'low.m3u8'));
  fs.writeFileSync(path.join(dir, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=640x360\nhigh.m3u8\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180\nlow.m3u8\n');
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const f = path.join(dir, path.basename(req.url));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
    res.end(fs.readFileSync(f));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/master.m3u8`;
  try {
    const runs0 = preview.stats.ffmpegRuns;
    const { id, file } = await preview.makePreview(url, { kind: 'hls' });
    assert.strictEqual(path.dirname(file), path.join(P.DATA_DIR, 'preview'));
    assert.strictEqual(id, preview.keyFor(url));
    assert.ok(fs.statSync(file).size < 400 * 1024);
    const pr = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width',
      '-of', 'json', file]);
    const info = JSON.parse(pr.stdout);
    assert.ok(Math.abs(Number(info.format.duration) - 2) <= 0.2, `duration ${info.format.duration}`);
    assert.deepStrictEqual(info.streams.map(s => s.codec_type), ['video']);
    assert.strictEqual(info.streams[0].width, 320);
    // Lowest variant, one segment only (30% of 20 s = 6 s -> segment 1).
    assert.ok(hits.includes('/low.m3u8') && !hits.includes('/high.m3u8'));
    assert.deepStrictEqual(hits.filter(h => h.endsWith('.ts')), ['/seg1.ts']);

    assert.strictEqual(preview.stats.ffmpegRuns, runs0 + 1);
    const again = await preview.makePreview(url, { kind: 'hls' });
    assert.strictEqual(again.file, file);
    assert.strictEqual(preview.stats.ffmpegRuns, runs0 + 1, 'cache hit must not run ffmpeg again');
    assert.deepStrictEqual((await preview.previewStatus(id)).state, 'ready');
  } finally {
    server.close();
  }
});

test('concurrent calls share one job; unknown id is none; cleanOld removes stale files', async () => {
  assert.strictEqual((await preview.previewStatus('f'.repeat(40))).state, 'none');
  assert.strictEqual((await preview.previewStatus('../x')).state, 'none');
  const dir = path.join(P.DATA_DIR, 'preview');
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'old.mp4');
  fs.writeFileSync(old, 'x');
  const past = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(old, past, past);
  const fresh = path.join(dir, 'fresh.mp4');
  fs.writeFileSync(fresh, 'x');
  await preview.cleanOld();
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh));
  const a = preview.startPreview('http://127.0.0.1:1/none.m3u8', { kind: 'hls' });
  const b = preview.startPreview('http://127.0.0.1:1/none.m3u8', { kind: 'hls' });
  assert.strictEqual(a.id, b.id);
  assert.strictEqual((await preview.previewStatus(a.id)).state, 'pending');
});

test('a runner that never exits is aborted by the timeout and the job fails (retry possible)', async () => {
  const seg = Buffer.alloc(188 * 4);
  for (let i = 0; i < 4; i++) seg[i * 188] = 0x47;
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('.m3u8')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\ns0.ts\n#EXT-X-ENDLIST\n');
    }
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.end(seg);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/hang.m3u8`;
  let aborted = false;
  // Fake runner: like a stalled child process, it ends only when the signal aborts.
  const runner = (exe, args, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  });
  try {
    const t0 = Date.now();
    await assert.rejects(preview.makePreview(url, { kind: 'hls', timeoutMs: 300, runner }));
    assert.ok(aborted, 'runner must receive the abort');
    assert.ok(Date.now() - t0 < 2000);
    assert.strictEqual((await preview.previewStatus(preview.keyFor(url))).state, 'error');
    // The next start retries instead of staying failed.
    const again = preview.startPreview(url, { kind: 'hls', timeoutMs: 300, runner });
    assert.strictEqual((await preview.previewStatus(again.id)).state, 'pending');
    await assert.rejects(preview.makePreview(url, { kind: 'hls', timeoutMs: 300, runner }));
  } finally {
    server.close();
  }
});

test('network inputs get -rw_timeout, local files do not', () => {
  assert.ok(preview.previewArgs('https://h/v.mp4', 1, 'o.mp4', { inputSeek: true }).includes('-rw_timeout'));
  assert.ok(!preview.previewArgs('/tmp/seg.ts', 1, 'o.mp4').includes('-rw_timeout'));
});
