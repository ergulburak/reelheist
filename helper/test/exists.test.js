'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { checkExists, resolveInside } = require('../lib/exists');
const BS = String.fromCharCode(92);

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rh-exists-')); }

test('finds existing mp4', () => {
  const out = tmp();
  fs.mkdirSync(path.join(out, 'Show'));
  const file = path.join(out, 'Show', 'Show.S01E02.mp4');
  fs.writeFileSync(file, 'hello');
  const r = checkExists(out, 'Show', 'Show.S01E02');
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.path, file);
  assert.strictEqual(r.size, 5);
  assert.ok(r.mtime);
});

test('missing -> exists:false', () => {
  const r = checkExists(tmp(), 'Nope', 'Nope');
  assert.deepStrictEqual(r, { exists: false, path: null, size: 0, mtime: null });
});

test('rejects path traversal and absolute paths', () => {
  const out = tmp();
  for (const [f, b] of [['..' + BS + 'x', 'a'], ['../x', 'a'], ['..', 'a'], ['a', '..'], ['C:' + BS + 'Windows', 'a'], ['a', BS + BS + 'srv' + BS + 'x'], ['', 'a'], ['a', ''], [null, 'a'], ['a', 'b/c']]) {
    assert.throws(() => checkExists(out, f, b), e => e.code === 'bad_request', JSON.stringify([f, b]));
  }
});

test('resolveInside accepts only .mp4 inside outDir', () => {
  const out = tmp();
  const ok = path.join(out, 'a', 'b.mp4');
  fs.mkdirSync(path.join(out, 'a'));
  fs.writeFileSync(ok, 'x');
  assert.strictEqual(resolveInside(out, ok), ok);
  assert.throws(() => resolveInside(out, path.join(out, 'a', 'b.txt')), e => e.code === 'bad_request');
  assert.throws(() => resolveInside(out, path.join(out, '..', 'x.mp4')), e => e.code === 'bad_request');
  assert.throws(() => resolveInside(out, 'x.mp4'), e => e.code === 'bad_request');
});

test('junction inside outDir that leaves outDir is rejected', () => {
  const out = tmp();
  const other = tmp();
  fs.writeFileSync(path.join(other, 'a.mp4'), 'secret');
  fs.mkdirSync(path.join(out, 'Real'));
  fs.writeFileSync(path.join(out, 'Real', 'ok.mp4'), 'x');
  fs.symlinkSync(other, path.join(out, 'Link'), 'junction');
  const viaLink = path.join(out, 'Link', 'a.mp4');
  assert.throws(() => resolveInside(out, viaLink), e => e.code === 'bad_request');
  assert.deepStrictEqual(checkExists(out, 'Link', 'a'), { exists: false, path: null, size: 0, mtime: null });
  assert.throws(() => resolveInside(out, path.join(out, 'Real', 'missing.mp4')), e => e.code === 'bad_request');
  const good = path.join(out, 'Real', 'ok.mp4');
  assert.strictEqual(resolveInside(out, good), good);
  assert.strictEqual(checkExists(out, 'Real', 'ok').exists, true);
});

test('HTTP: /api/exists answers 400 bad_request for traversal', async () => {
  const data = tmp();
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, REELHEIST_DATA: data }, stdio: 'ignore',
  });
  try {
    let info;
    for (let i = 0; i < 100 && !info; i++) {
      try { info = JSON.parse(fs.readFileSync(path.join(data, 'daemon.json'), 'utf8')); } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(info, 'daemon started');
    const get = q => fetch(`http://127.0.0.1:${info.port}/api/exists?${q}`, { headers: { 'X-Token': info.token } });
    const bad = await get('folder=' + encodeURIComponent('..' + BS + 'x') + '&base=a');
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await bad.json()).error, 'bad_request');
    const none = await get('folder=Zzz&base=Zzz');
    assert.strictEqual(none.status, 200);
    assert.strictEqual((await none.json()).exists, false);
    const noTok = await fetch(`http://127.0.0.1:${info.port}/api/exists?folder=a&base=a`);
    assert.strictEqual(noTok.status, 401);
  } finally {
    p.kill();
  }
});
