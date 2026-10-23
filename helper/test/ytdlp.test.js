'use strict';
const test = require('node:test');
const assert = require('node:assert');
const json = require('./fixtures/yt-multiaudio.json');
const yt = require('../lib/ytdlp');
const { buildNames } = require('../lib/names');

test('isYoutubeUrl', () => {
  assert.ok(yt.isYoutubeUrl('https://www.youtube.com/watch?v=x'));
  assert.ok(yt.isYoutubeUrl('https://youtu.be/x'));
  assert.ok(yt.isYoutubeUrl('https://music.youtube.com/watch?v=x'));
  assert.ok(!yt.isYoutubeUrl('https://video.example/dizi/x'));
});

test('normalize lists qualities, one audio per language, subtitles', () => {
  const n = yt.normalize(json);
  assert.strictEqual(n.type, 'ytdlp');
  assert.strictEqual(n.variants[0].height, 1080);
  assert.strictEqual(n.variants[0].codec, 'avc1');
  const langs = n.audios.map(a => a.lang);
  assert.strictEqual(new Set(langs).size, langs.length);
  assert.strictEqual(n.audios[0].original, true);
  assert.strictEqual(n.audios[0].lang, 'en-US');
  assert.ok(n.audios.some(a => a.lang === 'tr' && a.name === 'Turkish'));
  assert.ok(n.subtitles.some(s => s.lang === 'tr' && !s.auto));
  assert.ok(n.subtitles.length < 40, `subtitle list too long: ${n.subtitles.length}`);
});

test('selectFormats: H.264 up to height, original + Turkish by default, AAC preferred', () => {
  const s = yt.selectFormats(json, { height: 720 });
  assert.strictEqual(s.formats[0].height, 720);
  assert.match(s.formats[0].vcodec, /^avc1/);
  assert.deepStrictEqual(s.audios.map(a => a.language).sort(), ['en-US', 'tr']);
  for (const a of s.audios) assert.match(a.acodec, /^mp4a/);
  assert.ok(!s.ids.some(id => /drc/.test(id)));
});

test('selectFormats with explicit languages skips missing ones', () => {
  const s = yt.selectFormats(json, { height: 360, langs: ['de', 'xx'] });
  assert.deepStrictEqual(s.audios.map(a => a.language), ['de']);
  assert.strictEqual(s.formats[0].height, 360);
});

test('video names: channel folder, playlist index', () => {
  assert.deepStrictEqual(buildNames({ kind: 'video', name: 'A/B? Video', channel: 'MrBeast' }), { folder: 'MrBeast', base: 'A B Video' });
  assert.deepStrictEqual(buildNames({ kind: 'video', name: 'X', folder: 'Liste', index: 3 }), { folder: 'Liste', base: '03 - X' });
});

test('normalize returns size for every variant and audio (bytes or null)', () => {
  const n = yt.normalize(json);
  for (const v of n.variants) assert.ok(v.size === null || v.size > 0, `variant ${v.height}`);
  for (const a of n.audios) assert.ok(a.size === null || a.size > 0, `audio ${a.lang}`);
  const sel = yt.selectFormats(json, { height: n.variants[0].height });
  const f = sel.formats[0];
  assert.strictEqual(n.variants[0].size, f.filesize || f.filesize_approx || null);
  const a0 = sel.audios.find(a => a.language === n.audios[0].lang);
  assert.strictEqual(n.audios[0].size, a0.filesize || a0.filesize_approx || null);
});

test('normalize size: picks the format selectFormats would pick, null when unknown', () => {
  const j = { formats: [
    { format_id: 'v1', vcodec: 'vp09.0', acodec: 'none', height: 720, filesize: 900, tbr: 900 },
    { format_id: 'v2', vcodec: 'avc1.4d', acodec: 'none', height: 720, filesize_approx: 500, tbr: 500 },
    { format_id: 'v3', vcodec: 'avc1.4d', acodec: 'none', height: 360, tbr: 100 },
    { format_id: 'a1', vcodec: 'none', acodec: 'opus', language: 'en', abr: 160, filesize: 70, format_note: 'English original' },
    { format_id: 'a2', vcodec: 'none', acodec: 'mp4a.40', language: 'en', abr: 128, filesize: 60 },
  ] };
  const n = yt.normalize(j);
  assert.deepStrictEqual(n.variants.map(v => [v.height, v.size]), [[720, 500], [360, null]]);
  assert.strictEqual(n.audios[0].size, 60);
});
