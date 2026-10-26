'use strict';
// Subtitles inside the MP4: track plan, ffmpeg arguments, a real embed, and the queue's use of it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LOCAL = process.env.LOCALAPPDATA || '';
for (const app of ['ReelHeist', 'DiziIndirici']) {
  const dir = path.join(LOCAL, app, 'ffmpeg', 'bin');
  if (fs.existsSync(path.join(dir, 'ffmpeg.exe'))) { process.env.PATH = dir + path.delimiter + process.env.PATH; break; }
}
process.env.REELHEIST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-embed-'));

const muxMod = require('../lib/mux');
const { subtitleTrackPlan, embedArgs, embedSubtitles, findFfmpeg, ffprobePath } = muxMod;

const srt = (file, text) => {
  fs.writeFileSync(file, `﻿1\r\n00:00:00,500 --> 00:00:02,000\r\n${text}\r\n\r\n`, 'utf8');
  return file;
};

test('track plan: the default language turns on, forced and other languages stay off', () => {
  const subs = [
    { file: 'f.srt', lang: 'tr', forced: true },
    { file: 'en.srt', lang: 'en' },
    { file: 'tr.srt', lang: 'tr' },
  ];
  const plan = subtitleTrackPlan(subs, { defaultLang: 'tr', uiLang: 'tr' });
  // The track that turns on goes first: some TVs simply take the first one.
  assert.deepStrictEqual(plan.map(t => [t.file, t.lang3, t.isDefault]), [
    ['tr.srt', 'tur', true], ['f.srt', 'tur', false], ['en.srt', 'eng', false]]);
  assert.strictEqual(plan[0].title, 'Türkçe');
  assert.match(plan[1].title, /^Türkçe \(.+\)$/);
  assert.strictEqual(plan[2].title, 'İngilizce');
});

test('track plan: language codes are normalized; no match means no track turns on', () => {
  const plan = subtitleTrackPlan([{ file: 'a.srt', lang: 'en-US' }, { file: 'b.srt', lang: 'pt' }],
    { defaultLang: 'tr', uiLang: 'en' });
  assert.deepStrictEqual(plan.map(t => [t.lang3, t.isDefault, t.title]), [['eng', false, 'English'], ['por', false, 'Portuguese']]);
  const tur = subtitleTrackPlan([{ file: 'a.srt', lang: 'tur' }], { defaultLang: 'tr-TR', uiLang: 'en' });
  assert.strictEqual(tur[0].isDefault, true);
  const und = subtitleTrackPlan([{ file: 'x.srt', lang: 'und' }], { defaultLang: 'tr', uiLang: 'en' });
  assert.deepStrictEqual([und[0].lang3, und[0].isDefault], ['und', false]);
});

test('embedArgs copies audio and video, converts subtitles to mov_text and tags them', () => {
  const plan = [
    { file: 'tr.srt', lang3: 'tur', title: 'Türkçe', isDefault: true },
    { file: 'en.srt', lang3: 'eng', title: 'İngilizce', isDefault: false },
  ];
  const a = embedArgs('in.mp4', plan, 'out.mp4');
  const str = a.join(' ');
  assert.ok(str.includes('-i in.mp4 -i tr.srt -i en.srt'), str);
  assert.ok(str.includes('-map 0:v? -map 0:a? -map 1:0 -map 2:0'), str);
  assert.ok(str.includes('-c copy -c:s mov_text'), str);
  assert.ok(str.includes('-metadata:s:s:0 language=tur -metadata:s:s:0 title=Türkçe'), str);
  assert.ok(str.includes('-disposition:s:0 default -disposition:s:1 0'), str);
  assert.strictEqual(a[a.length - 1], 'out.mp4');
});

const ffmpeg = findFfmpeg();
const canRun = !!(ffmpeg && ffprobePath());

test('embedSubtitles puts the tracks into the MP4 and keeps the file name', { skip: !canRun }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-embed-run-'));
  const video = path.join(dir, 'Show.S01E01.mp4');
  const r = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=24:d=3', '-f', 'lavfi', '-i', 'sine=d=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', video]);
  assert.strictEqual(r.status, 0, r.stderr.toString());
  const subs = [
    { file: srt(path.join(dir, 'Show.S01E01.tr.forced.srt'), 'TABELA'), lang: 'tr', forced: true },
    { file: srt(path.join(dir, 'Show.S01E01.en.srt'), 'Hello'), lang: 'en' },
    { file: srt(path.join(dir, 'Show.S01E01.tr.srt'), 'Merhaba'), lang: 'tr' },
  ];
  const n = await embedSubtitles(video, subs, { defaultLang: 'tr', uiLang: 'tr' });
  assert.strictEqual(n, 3);
  const out = spawnSync(ffprobePath(), ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name:stream_tags=language,name,handler_name:stream_disposition=default', '-of', 'json', video]);
  const streams = JSON.parse(out.stdout.toString()).streams;
  assert.deepStrictEqual(streams.map(s => s.codec_type), ['video', 'audio', 'subtitle', 'subtitle', 'subtitle']);
  const subStreams = streams.filter(s => s.codec_type === 'subtitle');
  assert.deepStrictEqual(subStreams.map(s => [s.codec_name, s.tags.language, s.disposition.default]),
    [['mov_text', 'tur', 1], ['mov_text', 'tur', 0], ['mov_text', 'eng', 0]]);
  assert.deepStrictEqual([subStreams[0].tags.name, subStreams[0].tags.handler_name], ['Türkçe', 'Türkçe']);
  // The .srt files stay next to the video; no temporary file is left behind.
  assert.deepStrictEqual(fs.readdirSync(dir).sort(),
    ['Show.S01E01.en.srt', 'Show.S01E01.mp4', 'Show.S01E01.tr.forced.srt', 'Show.S01E01.tr.srt']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('embedSubtitles leaves the MP4 as it was when ffmpeg fails', { skip: !canRun }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-embed-fail-'));
  const video = path.join(dir, 'v.mp4');
  spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=24:d=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', video]);
  const before = fs.readFileSync(video);
  await assert.rejects(embedSubtitles(video, [{ file: path.join(dir, 'missing.srt'), lang: 'tr' }], { defaultLang: 'tr' }));
  assert.ok(fs.readFileSync(video).equals(before));
  assert.deepStrictEqual(fs.readdirSync(dir), ['v.mp4']);
  fs.rmSync(dir, { recursive: true, force: true });
});
