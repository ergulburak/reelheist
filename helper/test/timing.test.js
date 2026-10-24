'use strict';
// Timestamp handling: HLS discontinuities, rendition alignment, output check, idle timeout.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const LOCAL = process.env.LOCALAPPDATA || '';
for (const app of ['ReelHeist', 'DiziIndirici']) {
  const dir = path.join(LOCAL, app, 'ffmpeg', 'bin');
  if (fs.existsSync(path.join(dir, 'ffmpeg.exe'))) { process.env.PATH = dir + path.delimiter + process.env.PATH; break; }
}
process.env.REELHEIST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-timing-'));

const hls = require('../lib/hls');
const { discontinuityGroups, writeConcatInputs } = require('../lib/download');
const { buildArgs, inspect, mux, findFfmpeg, checkOutput, probeStreams } = require('../lib/mux');
const { request } = require('../lib/http');

test('parseMedia numbers discontinuity groups', () => {
  const text = `#EXTM3U
#EXTINF:6,
a.ts
#EXTINF:6,
b.ts
#EXT-X-DISCONTINUITY
#EXTINF:6,
c.ts
#EXT-X-DISCONTINUITY
#EXTINF:6,
d.ts
#EXT-X-ENDLIST`;
  const m = hls.parseMedia(text, 'https://x.test/p.m3u8');
  assert.deepStrictEqual(m.segments.map(s => s.disc), [0, 0, 1, 2]);
  assert.strictEqual(m.discontinuities, 2);
  assert.deepStrictEqual(discontinuityGroups(m.segments), [[0, 1], [2], [3]]);
  assert.deepStrictEqual(discontinuityGroups([{ disc: 0 }, { disc: 0 }]), [[0, 1]]);
});

test('writeConcatInputs: one group -> concatf, several -> concat demuxer list', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-concat-'));
  const dir = path.join(work, 's0');
  const one = { dir, fmp4: false, segments: [{ disc: 0 }, { disc: 0 }] };
  await writeConcatInputs(one, 0, work);
  assert.match(one.file, /^concatf:/);
  assert.ok(!one.concat);
  const listed = fs.readFileSync(one.file.slice(8), 'utf8').trim().split('\n');
  assert.strictEqual(listed.length, 2);
  assert.ok(listed.every(l => l.startsWith('file:') && !l.includes('\\')));

  const two = { dir, fmp4: false, segments: [{ disc: 0 }, { disc: 1 }, { disc: 1 }] };
  await writeConcatInputs(two, 1, work);
  assert.ok(two.concat);
  const groups = fs.readFileSync(two.file, 'utf8').trim().split('\n');
  assert.strictEqual(groups.length, 2);
  assert.match(groups[0], /^file 'concatf:.*stream1_0\.txt'$/);
  assert.strictEqual(fs.readFileSync(path.join(work, 'stream1_1.txt'), 'utf8').trim().split('\n').length, 2);
});

test('buildArgs: concat inputs get demuxer flags, offsets become -itsoffset', () => {
  const args = buildArgs([
    { file: 'v.txt', concat: true },
    { file: 'a.ts', lang: 'tr', offset: 0.5 },
  ], 0, 'out.mp4');
  const s = args.join(' ');
  assert.match(s, /-protocol_whitelist file,concatf,concat -safe 0 -f concat -i v\.txt -itsoffset 0\.500 -i a\.ts/);
  assert.ok(!/-itsoffset 0\.000/.test(s));
});

test('checkOutput flags audio/video length mismatch and playlist mismatch', () => {
  assert.strictEqual(checkOutput([{ type: 'video', duration: 2662 }, { type: 'audio', duration: 2663 }], 2662), null);
  const w = checkOutput([{ type: 'video', duration: 2662 }, { type: 'audio', duration: 2745 }], 2662);
  assert.strictEqual(w.code, 'av_mismatch');
  assert.match(w.detail, /44:22/);
  assert.match(w.detail, /45:45/);
  assert.strictEqual(checkOutput([{ type: 'video', duration: 2600 }], 2662).code, 'av_mismatch');
  assert.strictEqual(checkOutput([{ type: 'video', duration: 2650 }], 2662), null);
  assert.strictEqual(checkOutput([], 2662), null);
});

const ffmpeg = findFfmpeg();
const ffprobe = ffmpeg && path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const canRun = ffmpeg && fs.existsSync(ffprobe);

// Synthetic MPEG-TS: 24 fps test pattern + 440 Hz tone, timestamps starting at `offset` s.
function makeTs(dir, name, { seconds = 4, offset = 10, video = true, audio = true }) {
  const file = path.join(dir, name);
  const args = ['-hide_banner', '-nostdin', '-y', '-v', 'error'];
  if (video) args.push('-f', 'lavfi', '-i', `testsrc2=s=160x120:r=24:d=${seconds}`);
  if (audio) args.push('-f', 'lavfi', '-i', `sine=f=440:d=${seconds}:sample_rate=48000`);
  if (video) args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24');
  if (audio) args.push('-c:a', 'aac');
  args.push('-output_ts_offset', String(offset), '-f', 'mpegts', file);
  const r = spawnSync(ffmpeg, args);
  assert.strictEqual(r.status, 0, r.stderr.toString());
  return file;
}

function segFiles(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  files.forEach((f, i) => fs.copyFileSync(f, path.join(dir, `${String(i).padStart(6, '0')}.seg`)));
}

test('discontinuity: a forward PTS jump does not leave a gap in the MP4', { skip: !canRun }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-disc-'));
  const a = makeTs(work, 'a.ts', { offset: 10 });
  const b = makeTs(work, 'b.ts', { offset: 60 }); // ad break removed: timestamps jump 46 s
  const s = { kind: 'video', dir: path.join(work, 's0'), fmp4: false, duration: 8, segments: [{ disc: 0 }, { disc: 1 }] };
  segFiles(s.dir, [a, b]);
  await writeConcatInputs(s, 0, work);
  const out = path.join(work, 'out.mp4');
  await mux([s], out, { duration: 8 });
  const streams = await probeStreams(ffmpeg, out);
  const v = streams.find(x => x.type === 'video');
  const au = streams.find(x => x.type === 'audio');
  assert.ok(Math.abs(v.duration - 8) < 0.3, `video ${v.duration}`);
  assert.ok(Math.abs(au.duration - 8) < 0.3, `audio ${au.duration}`);
  assert.strictEqual(checkOutput(streams, 8), null);
});

test('separate audio rendition keeps its PTS offset against the video', { skip: !canRun }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-align-'));
  const v = { kind: 'video', dir: path.join(work, 's0'), fmp4: false, duration: 4, segments: [{ disc: 0 }] };
  const a = { kind: 'audio', dir: path.join(work, 's1'), fmp4: false, duration: 3, lang: 'tr', name: 'Türkçe', segments: [{ disc: 0 }] };
  segFiles(v.dir, [makeTs(work, 'v.ts', { offset: 10, audio: false })]);
  segFiles(a.dir, [makeTs(work, 'a.ts', { seconds: 3, offset: 10.8, video: false })]);
  await writeConcatInputs(v, 0, work);
  await writeConcatInputs(a, 1, work);
  const iv = await inspect(ffmpeg, v);
  const ia = await inspect(ffmpeg, a);
  // The TS muxer adds its own fixed delay to both; only the gap between them matters.
  assert.ok(Math.abs(ia.start - iv.start - 0.8) < 0.05, `${iv.start} ${ia.start}`);
  const out = path.join(work, 'out.mp4');
  await mux([v, a], out, { duration: 4 });
  const streams = await probeStreams(ffmpeg, out);
  const au = streams.find(x => x.type === 'audio');
  assert.ok(Math.abs(au.start - 0.8) < 0.05, `audio starts at ${au.start}, expected 0.8`);
});

test('request: idle timeout tolerates a slow stream but aborts a stall', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    if (req.url === '/slow') {
      let n = 0;
      const t = setInterval(() => { res.write(Buffer.alloc(1000, 1)); if (++n === 6) { clearInterval(t); res.end(); } }, 120);
    } else {
      res.write(Buffer.alloc(10, 1)); // then silence
    }
  }).listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const { buf } = await request(`${base}/slow`, { timeoutMs: 300, retries: 0 }); // 720 ms total, gaps of 120 ms
    assert.strictEqual(buf.length, 6000);
    await assert.rejects(request(`${base}/stall`, { timeoutMs: 300, retries: 0 }), /timeout/);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});
