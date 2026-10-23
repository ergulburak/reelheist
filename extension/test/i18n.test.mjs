import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, initI18n, t, isRtl, currentLang, resolveLang } from '../lib/i18n.js';
import { THEMES, applyTheme } from '../lib/theme.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '_locales');
const read = l => JSON.parse(fs.readFileSync(path.join(dir, l, 'messages.json'), 'utf8'));
const loader = async l => read(l);
const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

test('there are exactly the 12 locales', () => {
  assert.deepStrictEqual([...LOCALES].sort(), ['ar', 'de', 'en', 'es', 'fr', 'hi', 'id', 'ja', 'pt_BR', 'ru', 'tr', 'zh_CN']);
});

test('every locale has exactly the keys of en', () => {
  const ref = Object.keys(read('en')).sort();
  for (const l of LOCALES) {
    assert.deepStrictEqual(Object.keys(read(l)).sort(), ref, l);
  }
});

test('no empty messages', () => {
  for (const l of LOCALES) for (const [k, v] of Object.entries(read(l))) assert.ok(v.message.trim(), `${l}.${k}`);
});

test('placeholders match en for every key', () => {
  const en = read('en');
  for (const l of LOCALES) {
    const loc = read(l);
    for (const k of Object.keys(en)) assert.strictEqual(placeholders(loc[k].message), placeholders(en[k].message), `${l}.${k}`);
  }
});

test('t substitutes {name} placeholders', async () => {
  await initI18n('en', { loader });
  assert.strictEqual(t('audios_other', { n: 3 }), 'Other languages (3)');
});

test('t falls back to en then key', async () => {
  const partial = async l => (l === 'en'
    ? { a: { message: 'EN a' }, b: { message: 'EN b' } }
    : { a: { message: 'TR a' } });
  await initI18n('tr', { loader: partial });
  assert.strictEqual(t('a'), 'TR a');
  assert.strictEqual(t('b'), 'EN b');
  assert.strictEqual(t('zzz'), 'zzz');
});

test('ar is rtl, others ltr', async () => {
  for (const l of LOCALES) {
    await initI18n(l, { loader });
    assert.strictEqual(currentLang(), l);
    assert.strictEqual(isRtl(), l === 'ar', l);
  }
});

test('auto maps the browser language to the nearest locale', async () => {
  assert.strictEqual(resolveLang('pt-BR'), 'pt_BR');
  assert.strictEqual(resolveLang('pt-PT'), 'pt_BR');
  assert.strictEqual(resolveLang('zh-CN'), 'zh_CN');
  assert.strictEqual(resolveLang('zh'), 'zh_CN');
  assert.strictEqual(resolveLang('zh-TW'), 'zh_CN');
  assert.strictEqual(resolveLang('de-AT'), 'de');
  assert.strictEqual(resolveLang('en-GB'), 'en');
  assert.strictEqual(resolveLang('xx'), 'en');
  await initI18n('auto', { loader, uiLanguage: 'fr-CA' });
  assert.strictEqual(currentLang(), 'fr');
});

test('applyTheme sets data-theme and rejects unknown names', () => {
  const doc = { documentElement: { dataset: {} } };
  assert.strictEqual(applyTheme('beige-black', doc), 'beige-black');
  assert.strictEqual(doc.documentElement.dataset.theme, 'beige-black');
  assert.strictEqual(applyTheme('nope', doc), 'red');
  assert.deepStrictEqual(THEMES, ['red', 'black-beige', 'beige-black', 'midnight', 'emerald', 'amethyst', 'amber', 'snow', 'rose']);
});
