import test from 'node:test';
import assert from 'node:assert';
import { analyzeSources, qualities, audioTracks, formatDuration } from '../lib/sources.js';

const master = {
  type: 'master',
  url: 'https://p.test/master.m3u8?v=1',
  duration: 2520,
  variants: [
    { url: 'https://p.test/l.php?v=720', height: 720, audioGroup: 'a' },
    { url: 'https://p.test/l.php?v=1080', height: 1080, audioGroup: 'a' },
  ],
  audios: [
    { url: 'https://p.test/ld.php?v=tr', name: 'Türkçe', lang: 'tr', groupId: 'a' },
    { url: 'https://p.test/ld.php?v=en', name: 'İngilizce', lang: 'en', groupId: 'a', isDefault: true },
    { url: null, name: 'Muxed', lang: 'en', groupId: 'a' },
  ],
  subtitles: [],
};

test('variants and audio playlists of a master are hidden; longest first', async () => {
  const sources = [
    { url: 'https://ads.test/ad.m3u8', kind: 'hls' },
    { url: master.url, kind: 'hls' },
    { url: 'https://p.test/l.php?v=1080', kind: 'hls' },
    { url: 'https://p.test/ld.php?v=tr', kind: 'hls' },
    { url: 'https://bad.test/x.m3u8', kind: 'hls' },
  ];
  const probes = {
    'https://ads.test/ad.m3u8': { type: 'media', url: 'https://ads.test/ad.m3u8', duration: 15, variants: [], audios: [], subtitles: [] },
    [master.url]: master,
    'https://p.test/l.php?v=1080': { type: 'media', url: 'https://p.test/l.php?v=1080', duration: 2520, variants: [], audios: [], subtitles: [] },
    'https://p.test/ld.php?v=tr': { type: 'media', url: 'https://p.test/ld.php?v=tr', duration: 2520, variants: [], audios: [], subtitles: [] },
  };
  const list = await analyzeSources(sources, async s => {
    if (!probes[s.url]) throw new Error('HTTP 403');
    return probes[s.url];
  });
  assert.deepStrictEqual(list.map(r => r.source.url), [master.url, 'https://ads.test/ad.m3u8']);
  assert.deepStrictEqual(list.errors, ['HTTP 403']);
  assert.strictEqual(list[0].label, '1080p · 42 dk · p.test');
});

test('minDuration marks trailers and ads as short', async () => {
  const sources = [
    { url: 'https://yt.test/trailer.m3u8', kind: 'hls' },
    { url: master.url, kind: 'hls' },
    { url: 'https://p.test/file.mp4', kind: 'file' },
  ];
  const probes = {
    'https://yt.test/trailer.m3u8': { type: 'master', url: 'https://yt.test/trailer.m3u8', duration: 12, variants: [], audios: [], subtitles: [] },
    [master.url]: master,
  };
  const list = await analyzeSources(sources, async s => probes[s.url], { minDuration: 120 });
  assert.deepStrictEqual(list.map(r => [r.source.url, r.short]), [
    [master.url, false],
    ['https://p.test/file.mp4', false], // unknown length is not short
    ['https://yt.test/trailer.m3u8', true],
  ]);
  const plain = await analyzeSources(sources.slice(0, 1), async s => probes[s.url]);
  assert.strictEqual(plain[0].short, false);
});

test('file source with known short duration is short', async () => {
  const sources = [
    { url: 'https://ads.test/ad.mp4', kind: 'file' },
    { url: master.url, kind: 'hls' },
  ];
  const probes = {
    'https://ads.test/ad.mp4': { type: 'file', variants: [], audios: [], subtitles: [], duration: 20 },
    [master.url]: master,
  };
  const list = await analyzeSources(sources, async s => probes[s.url], { minDuration: 120 });
  assert.deepStrictEqual(list.map(r => [r.source.url, r.short]), [
    [master.url, false],
    ['https://ads.test/ad.mp4', true],
  ]);
  // A file probe that fails keeps the old fixed result (unknown length, not short).
  const failed = await analyzeSources(sources.slice(0, 1), async () => { throw new Error('ffprobe'); }, { minDuration: 120 });
  assert.deepStrictEqual(failed.map(r => [r.probe.type, r.short]), [['file', false]]);
});

test('qualities and audio tracks', () => {
  assert.deepStrictEqual(qualities(master), [1080, 720]);
  assert.deepStrictEqual(audioTracks(master, null).map(a => a.name), ['Türkçe', 'İngilizce']);
  assert.strictEqual(formatDuration(6540), '1 sa 49 dk');
});
