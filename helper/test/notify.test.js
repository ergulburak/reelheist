'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const notify = require('../lib/notify');

test('toastArgs builds a script file call and passes text through env', () => {
  const { args, env } = notify.toastArgs({ title: 'Show "x"', body: 'a <b> & c' });
  assert.deepStrictEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  const file = args[args.length - 1];
  assert.strictEqual(args[args.length - 2], '-File');
  assert.ok(file.endsWith('.ps1'));
  const script = fs.readFileSync(file, 'utf8');
  assert.ok(script.includes('ToastText02'));
  assert.ok(script.includes('GetElementsByTagName'));
  assert.strictEqual(env.REELHEIST_TOAST_TITLE, 'Show "x"');
  assert.strictEqual(env.REELHEIST_TOAST_BODY, 'a <b> & c');
  assert.strictEqual(env.REELHEIST_TOAST_APPID, 'ReelHeist');
  assert.ok(env.REELHEIST_TOAST_ICON.endsWith(require('path').join('app', 'extension', 'icons', 'icon128.png')));
  assert.ok(script.includes('AppUserModelId'));
});

test('send does nothing under node --test', async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT);
  await notify.send({ title: 'ReelHeist', body: 'never shown' });
});

test('texts returns the language file and falls back to en', () => {
  assert.strictEqual(notify.texts('tr').notify_done, '{name} indi · {size}');
  assert.strictEqual(notify.texts('xx').notify_done, '{name} downloaded · {size}');
  for (const k of ['notify_done', 'notify_done_subs', 'notify_done_warn', 'notify_failed', 'notify_season_done', 'notify_resume']) {
    assert.strictEqual(typeof notify.texts('en')[k], 'string');
  }
});

test('texts rejects path-like language codes', () => {
  assert.strictEqual(notify.texts('../../x').notify_done, '{name} downloaded · {size}');
});

test('fill replaces placeholders and formatSize picks the unit', () => {
  assert.strictEqual(notify.fill('{name} {n} {name}', { name: 'A', n: 2 }), 'A 2 A');
  assert.strictEqual(notify.formatSize(450e6), '450 MB');
  assert.strictEqual(notify.formatSize(1.1e9), '1.1 GB');
});

test('every toast key has a text, the subtitle-only one too', () => {
  for (const lang of ['en', 'tr', 'de', 'ar']) {
    const t = notify.texts(lang);
    for (const k of ['notify_done', 'notify_done_subs', 'notify_done_subs_only', 'notify_done_warn',
      'notify_failed', 'notify_season_done', 'notify_resume']) {
      assert.ok(t[k] && !t[k].includes('undefined'), `${lang} ${k}`);
    }
  }
});

test('an empty value drops its separator; an unknown size is empty', () => {
  assert.strictEqual(notify.fill('{name} indi · {size}', { name: 'A', size: notify.formatSize(undefined) }), 'A indi');
  assert.strictEqual(notify.fill('{name} · {size} · {n} x', { name: 'A', size: '', n: 2 }), 'A · 2 x');
  assert.strictEqual(notify.fill('{n} left', {}), '{n} left');
  assert.strictEqual(notify.formatSize(0), '');
  assert.strictEqual(notify.formatSize(300e3), '1 MB');
});

test('errorText reads the extension texts and falls back to en', () => {
  assert.match(notify.errorText('tr', 'episode_short'), /kısa/i);
  assert.match(notify.errorText('xx', 'episode_short'), /short video/i);
  assert.strictEqual(notify.errorText('en', 'no_such_code'), '');
  assert.strictEqual(notify.errorText('en', null), '');
});
