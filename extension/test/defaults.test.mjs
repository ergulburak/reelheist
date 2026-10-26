import { test } from 'node:test';
import assert from 'node:assert';
import { chooseDefaults, rememberChoice, applyRemember, subtitleKey, MEMORY_CAP, embedSubsOption } from '../lib/defaults.js';

const yt = {
  type: 'ytdlp',
  variants: [{ height: 2160, codec: 'vp09' }, { height: 1080, codec: 'avc1' }, { height: 720, codec: 'avc1' }],
  audios: [
    { lang: 'en-US', name: 'English', original: true },
    { lang: 'tr', name: 'Turkish', original: false },
    { lang: 'es-US', name: 'Spanish', original: false },
  ],
  subtitles: [
    { lang: 'tr', name: 'Turkish', auto: false },
    { lang: 'en', name: 'English', auto: false },
    { lang: 'de', name: 'German', auto: false },
    { lang: 'en-orig', name: 'English (auto)', auto: true },
    { lang: 'fr', name: 'French', auto: false },
  ],
};

test('tr UI: original + tr dub, subs tr+en+orig, best H.264 height', () => {
  const d = chooseDefaults(yt, { uiLang: 'tr' });
  assert.strictEqual(d.height, 1080);
  assert.deepStrictEqual(d.audioLangs, ['en-US', 'tr']);
  assert.deepStrictEqual(d.subtitleKeys, ['tr', 'en']);
});

test('de UI with no de dub: only original audio, subs de(if exists)+en', () => {
  const d = chooseDefaults(yt, { uiLang: 'de' });
  assert.deepStrictEqual(d.audioLangs, ['en-US']);
  assert.deepStrictEqual(d.subtitleKeys, ['en', 'de']);
});

test('pt_BR UI matches pt by primary subtag, case-insensitive', () => {
  const p = { ...yt, audios: [...yt.audios, { lang: 'pt-BR', name: 'Portuguese', original: false }] };
  assert.deepStrictEqual(chooseDefaults(p, { uiLang: 'pt_BR' }).audioLangs, ['en-US', 'pt-BR']);
  assert.deepStrictEqual(chooseDefaults(p, { uiLang: 'PT' }).audioLangs, ['en-US', 'pt-BR']);
});

test('HLS without languages -> all', () => {
  const hls = {
    type: 'master',
    variants: [{ height: 720, audioGroup: 'a' }, { height: 1080, audioGroup: 'a' }],
    audios: [{ name: 'Track 1', lang: '', isDefault: true, url: 'u1', groupId: 'a' }, { name: 'Track 2', lang: '', url: 'u2', groupId: 'a' }],
    subtitles: [],
  };
  const d = chooseDefaults(hls, { uiLang: 'tr' });
  assert.strictEqual(d.audioLangs, 'all');
  assert.strictEqual(d.height, 1080);
});

test('HLS with languages: default rendition is the original', () => {
  const hls = {
    type: 'master',
    variants: [{ height: 1080 }],
    audios: [
      { name: 'Deutsch', lang: 'de', isDefault: true, url: 'u1' },
      { name: 'Turkce', lang: 'tr', url: 'u2' },
      { name: 'Francais', lang: 'fr', url: 'u3' },
    ],
    subtitles: [{ name: 'English', lang: 'en', url: 's1' }, { name: 'Other', lang: '', url: 's2' }],
  };
  const d = chooseDefaults(hls, { uiLang: 'tr' });
  assert.deepStrictEqual(d.audioLangs, ['de', 'tr']);
  assert.deepStrictEqual(d.subtitleKeys, ['en']);
});

test('page subtitles use lang, or label when lang is empty', () => {
  assert.strictEqual(subtitleKey({ lang: 'en' }), 'en');
  assert.strictEqual(subtitleKey({ lang: '', label: 'Forced' }), 'Forced');
  assert.strictEqual(subtitleKey({ lang: 'en', auto: true }), 'en:auto');
});

test('defaults.quality caps height; explicit langs replace the rule', () => {
  assert.strictEqual(chooseDefaults(yt, { uiLang: 'tr', defaults: { quality: 720 } }).height, 720);
  assert.strictEqual(chooseDefaults(yt, { uiLang: 'tr', defaults: { quality: 480 } }).height, 720);
  const d = chooseDefaults(yt, { uiLang: 'tr', defaults: { audioLangs: ['es'], subLangs: ['fr'] } });
  assert.deepStrictEqual(d.audioLangs, ['es-US']);
  assert.deepStrictEqual(d.subtitleKeys, ['fr']);
});

test('memory overrides but drops missing languages', () => {
  const memory = { 'a.example': { audioLangs: ['es-US', 'ja'], subtitleKeys: ['de', 'xx', 'en-orig:auto'], height: 720, t: 1 } };
  const d = chooseDefaults(yt, { uiLang: 'tr', memory, host: 'a.example' });
  assert.deepStrictEqual(d.audioLangs, ['es-US']);
  assert.deepStrictEqual(d.subtitleKeys, ['de', 'en-orig:auto']);
  assert.strictEqual(d.height, 720);
  // Other host: rule applies.
  assert.deepStrictEqual(chooseDefaults(yt, { uiLang: 'tr', memory, host: 'b.example' }).audioLangs, ['en-US', 'tr']);
  // Remembered height that no longer exists falls back to the rule.
  const m2 = { h: { audioLangs: ['tr'], subtitleKeys: [], height: 144, t: 1 } };
  const d2 = chooseDefaults(yt, { uiLang: 'tr', memory: m2, host: 'h' });
  assert.strictEqual(d2.height, 1080);
  assert.deepStrictEqual(d2.subtitleKeys, []);
});

test('memory cap 200: oldest entries are removed', () => {
  let mem = {};
  for (let i = 0; i < 205; i++) mem = applyRemember(mem, `h${i}.example`, { audioLangs: 'all', subtitleKeys: [], height: null }, 1000 + i);
  assert.strictEqual(Object.keys(mem).length, MEMORY_CAP);
  assert.ok(!mem['h0.example'] && !mem['h4.example']);
  assert.ok(mem['h5.example'] && mem['h204.example']);
  // Updating an existing host refreshes it instead of growing the map.
  mem = applyRemember(mem, 'h5.example', { audioLangs: ['tr'], subtitleKeys: [], height: 720 }, 5000);
  assert.strictEqual(Object.keys(mem).length, MEMORY_CAP);
  assert.strictEqual(mem['h5.example'].t, 5000);
});

test('rememberChoice stores into settings.siteMemory', async () => {
  const store = { settings: { theme: 'red' } };
  globalThis.chrome = { storage: { local: {
    get: async k => ({ [k]: store[k] }),
    set: async o => Object.assign(store, o),
  } } };
  await rememberChoice('x.example', { audioLangs: ['tr'], subtitleKeys: ['en'], height: 720 });
  assert.strictEqual(store.settings.theme, 'red');
  assert.deepStrictEqual(Object.keys(store.settings.siteMemory), ['x.example']);
  assert.strictEqual(store.settings.siteMemory['x.example'].height, 720);
  delete globalThis.chrome;
});

test('embedSubsOption: on by default, first default subtitle language turns on', () => {
  assert.deepStrictEqual(embedSubsOption({ defaults: { subLangs: ['tr', 'en'] } }, 'en'), { lang: 'tr', keepSrt: true });
  assert.deepStrictEqual(embedSubsOption({ defaults: { subLangs: ['pt_BR'] } }, 'en'), { lang: 'pt', keepSrt: true });
});

test('embedSubsOption: no default subtitle language means the interface language', () => {
  assert.deepStrictEqual(embedSubsOption({ defaults: {} }, 'de-DE'), { lang: 'de', keepSrt: true });
  assert.deepStrictEqual(embedSubsOption({}, 'tr'), { lang: 'tr', keepSrt: true });
});

test('embedSubsOption: "keep .srt files" turned off is sent as keepSrt false', () => {
  assert.deepStrictEqual(embedSubsOption({ defaults: { keepSrt: false, subLangs: ['tr'] } }, 'en'), { lang: 'tr', keepSrt: false });
});

test('embedSubsOption: the setting turned off gives null', () => {
  assert.strictEqual(embedSubsOption({ defaults: { embedSubs: false, subLangs: ['tr'] } }, 'tr'), null);
});
