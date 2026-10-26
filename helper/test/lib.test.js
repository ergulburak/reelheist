'use strict';
const test = require('node:test');
const assert = require('node:assert');
const hls = require('../lib/hls');
const subs = require('../lib/subtitles');
const names = require('../lib/names');
const { stripToTsSync, ivForSegment } = require('../lib/download');
const { pickVariant } = require('../lib/probe');
const { buildArgs } = require('../lib/mux');

const MASTER = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Türkçe",LANGUAGE="tr",DEFAULT=YES,URI="audio/tr.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=NO,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Türkçe",LANGUAGE="tr",URI="subs/tr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,AUDIO="aud",SUBTITLES="subs"
480/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"
https://cdn.example.com/1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="aud"
720/index.m3u8
`;

test('parseMaster finds variants, audio and subtitle renditions', () => {
  assert.ok(hls.isMaster(MASTER));
  const m = hls.parseMaster(MASTER, 'https://x.test/hls/master.m3u8?t=1');
  assert.deepStrictEqual(m.variants.map(v => v.height), [480, 1080, 720]);
  assert.strictEqual(m.variants[0].url, 'https://x.test/hls/480/index.m3u8');
  assert.strictEqual(m.variants[1].url, 'https://cdn.example.com/1080/index.m3u8');
  assert.strictEqual(m.variants[1].audioGroup, 'aud');
  assert.strictEqual(m.audios.length, 2);
  assert.strictEqual(m.audios[0].name, 'Türkçe');
  assert.strictEqual(m.audios[0].isDefault, true);
  assert.strictEqual(m.audios[1].url, 'https://x.test/hls/audio/en.m3u8');
  assert.strictEqual(m.subtitles[0].lang, 'tr');
});

test('pickVariant picks highest fitting quality', () => {
  const m = hls.parseMaster(MASTER, 'https://x.test/m.m3u8');
  assert.strictEqual(pickVariant(m.variants, null).height, 1080);
  assert.strictEqual(pickVariant(m.variants, 720).height, 720);
  assert.strictEqual(pickVariant(m.variants, 1000).height, 720);
  assert.strictEqual(pickVariant(m.variants, 240).height, 480);
});

test('parseMedia handles keys, maps, byte ranges and disguised segments', () => {
  const text = `#EXTM3U
#EXT-X-TARGETDURATION:8
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0000000000000000000000000000000A
#EXT-X-MAP:URI="init.mp4"
#EXTINF:7.5,
seg1.jpg
#EXT-X-BYTERANGE:1000@0
#EXTINF:6,
big.ts
#EXT-X-BYTERANGE:500
#EXTINF:6,
big.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:2.5,
https://other.test/last.png
#EXT-X-ENDLIST`;
  const m = hls.parseMedia(text, 'https://a.test/p/list.m3u8');
  assert.strictEqual(m.segments.length, 4);
  assert.strictEqual(m.duration, 22);
  assert.strictEqual(m.segments[0].url, 'https://a.test/p/seg1.jpg');
  assert.strictEqual(m.segments[0].seq, 5);
  assert.strictEqual(m.segments[0].key.url, 'https://a.test/p/key.bin');
  assert.strictEqual(m.segments[0].map.url, 'https://a.test/p/init.mp4');
  assert.deepStrictEqual(m.segments[1].range, { offset: 0, length: 1000 });
  assert.deepStrictEqual(m.segments[2].range, { offset: 1000, length: 500 });
  assert.strictEqual(m.segments[3].key, null);
  assert.ok(m.endList);
});

test('ivForSegment uses explicit IV or sequence number', () => {
  assert.strictEqual(ivForSegment({ iv: '0x0A' }, 0).toString('hex'), '0000000000000000000000000000000a');
  assert.strictEqual(ivForSegment({}, 258).toString('hex'), '00000000000000000000000000000102');
});

test('stripToTsSync removes a fake image header', () => {
  const ts = Buffer.alloc(188 * 4);
  for (let i = 0; i < 4; i++) ts[i * 188] = 0x47;
  assert.strictEqual(stripToTsSync(ts), ts);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const out = stripToTsSync(Buffer.concat([png, ts]));
  assert.strictEqual(out.length, ts.length);
  assert.strictEqual(out[0], 0x47);
});

test('vttToSrt converts times, drops settings and tags', () => {
  const vtt = `WEBVTT

00:06.049 --> 00:08.530 align:middle line:90%
This family is
on the <c.yellow>brink</c> of <i>civil war</i>.

NOTE comment

intro
01:00:10.140 --> 01:00:12.099
Kat &amp; co.
`;
  const srt = subs.vttToSrt(vtt);
  assert.strictEqual(srt,
    '1\n00:00:06,049 --> 00:00:08,530\nThis family is\non the brink of <i>civil war</i>.\n\n' +
    '2\n01:00:10,140 --> 01:00:12,099\nKat & co.\n');
});

test('toSrt keeps SRT input', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n';
  assert.strictEqual(subs.toSrt(srt), '1\n00:00:01,000 --> 00:00:02,000\nHi\n');
});

test('mergeVttSegments applies X-TIMESTAMP-MAP and removes duplicates', () => {
  const a = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.000\nA\n';
  const b = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.000\nA\n\n00:00:03.000 --> 00:00:04.000\nB\n';
  const out = subs.mergeVttSegments([a, b], 10000);
  assert.strictEqual(out, '1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:03,000 --> 00:00:04,000\nB\n');
});

test('guessLang uses lang, label, then URL', () => {
  assert.strictEqual(names.guessLang({ lang: 'tr' }), 'tr');
  assert.strictEqual(names.guessLang({ lang: 'eng' }), 'en');
  assert.strictEqual(names.guessLang({ label: 'Türkçe' }), 'tr');
  assert.strictEqual(names.guessLang({ label: 'İngilizce' }), 'en');
  assert.strictEqual(names.guessLang({ label: 'French' }), 'fr');
  assert.strictEqual(names.guessLang({ url: 'https://h.test/vtt/x-subtitles02.fre.vtt' }), 'fr');
  assert.strictEqual(names.guessLang({ label: 'Altyazı 3' }), 'und');
});

test('buildNames and subtitle suffixes', () => {
  assert.deepStrictEqual(names.buildNames({ kind: 'episode', name: 'MobLand', season: 2, episode: 6 }),
    { folder: 'MobLand', base: 'MobLand.S02E06' });
  assert.deepStrictEqual(names.buildNames({ kind: 'movie', name: 'Clean Hands', year: 2026 }),
    { folder: 'Clean Hands (2026)', base: 'Clean Hands (2026)' });
  assert.strictEqual(names.sanitize('A: B / C?'), 'A B C');
  assert.deepStrictEqual(names.subtitleSuffixes([{ lang: 'tr' }, { label: 'English' }, { label: 'Turkish' }]),
    ['tr', 'en', 'tr.2']);
});

test('forced subtitles get a ".forced" suffix, whatever the page order', () => {
  // Real order from a season page (What We Do in the Shadows S01E02): forced track first.
  const base = 'https://cdn.example/s01e02-webdl-trdual';
  const forced = { label: 'Forced', url: `${base}_subtitles02.tur.forced.vtt` };
  const full = { label: 'Turkish', url: `${base}_subtitles03.tur.vtt` };
  const en = { label: 'English', url: `${base}_subtitles01.eng.vtt` };
  assert.deepStrictEqual(names.subtitleSuffixes([forced, en, full]), ['tr.forced', 'en', 'tr']);
  assert.deepStrictEqual(names.subtitleSuffixes([full, en, forced]), ['tr', 'en', 'tr.forced']);
  // HLS FORCED=YES flag, and a Turkish label.
  assert.deepStrictEqual(names.subtitleSuffixes([{ lang: 'tr', forced: true }, { lang: 'tr' }]), ['tr.forced', 'tr']);
  assert.deepStrictEqual(names.subtitleSuffixes([{ label: 'Türkçe (Zorunlu)' }, { label: 'Türkçe' }]), ['tr.forced', 'tr']);
  assert.deepStrictEqual(names.subtitleSuffixes([{ lang: 'tr', forced: true }, { lang: 'tr', forced: true }]),
    ['tr.forced', 'tr.forced.2']);
  // "forced" inside a word is not a flag.
  assert.strictEqual(names.isForcedSubtitle({ label: 'Unforced Errors', url: 'https://x/unforced.en.vtt' }), false);
});

test('buildArgs maps every audio and tags languages', () => {
  const args = buildArgs([
    { file: 'v.ts' },
    { file: 'a0.ts', lang: 'tr', name: 'Türkçe', isDefault: false },
    { file: 'a1.ts', lang: 'en', name: 'English', isDefault: true },
  ], 0, 'out.mp4');
  const s = args.join(' ');
  assert.match(s, /-i v\.ts -i a0\.ts -i a1\.ts/);
  assert.match(s, /-map 0:v:0\? -map 0:a\? -map 1:a:0 -map 2:a:0 -c copy/);
  assert.match(s, /-metadata:s:a:0 language=tur/);
  assert.match(s, /-metadata:s:a:1 language=eng/);
  assert.match(s, /-disposition:a:0 0 -disposition:a:1 default/);
  assert.strictEqual(args[args.length - 1], 'out.mp4');
});

test('errors: codes map to the shared list and HTTP expiry becomes link_expired', () => {
  const { CODES, CodedError, toCoded } = require('../lib/errors');
  assert.deepStrictEqual(CODES, ['link_expired', 'drm', 'no_quality', 'playlist_empty', 'not_hls', 'ffmpeg_missing',
    'ytdlp_missing', 'ytdlp_failed', 'live', 'bad_segment', 'no_video', 'bad_request', 'internal',
    'episode_timeout', 'episode_unreadable', 'episode_short', 'episode_interrupted', 'state', 'no_subtitles']);
  assert.deepStrictEqual(toCoded(new CodedError('drm', 'encrypted')), { code: 'drm', detail: 'encrypted' });
  assert.deepStrictEqual(toCoded(Object.assign(new Error('HTTP 403'), { status: 403 })).code, 'link_expired');
  assert.strictEqual(toCoded(new Error('boom')).code, 'internal');
});

test('probe rejects a non-HLS body with code not_hls', async () => {
  const http = require('http');
  const { probe } = require('../lib/probe');
  const srv = http.createServer((q, r) => r.end('<html>nope</html>')).listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  try {
    await assert.rejects(probe({ url: `http://127.0.0.1:${srv.address().port}/x.m3u8` }), e => e.code === 'not_hls');
  } finally { srv.close(); }
});
