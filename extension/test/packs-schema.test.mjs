import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { validatePack } from '../lib/packs/schema.js';

const example = () => JSON.parse(readFileSync(new URL('../../packs/example.json', import.meta.url), 'utf8'));

test('accepts example pack', () => {
  const r = validatePack(example());
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.pack.id, 'example');
});

test('rejects bad id', () => {
  for (const id of ['A', 'x', 'has space', 'UPPER', 'a'.repeat(41), 5]) {
    const p = example(); p.id = id;
    const r = validatePack(p);
    assert.strictEqual(r.ok, false, String(id));
    assert.ok(r.errors.some((e) => e.startsWith('id')));
  }
});

test('rejects uncompilable regex with field path in error', () => {
  const p = example(); p.title.strip = ['(unclosed'];
  const r = validatePack(p);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.includes('title.strip[0]: invalid regex'), r.errors.join('|'));
});

test('requires named groups season/episode', () => {
  const p = example(); p.title.episodeUrl = ['/s([0-9]+)/e([0-9]+)'];
  let r = validatePack(p);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('title.episodeUrl[0]')));
  const q = example(); q.episodes.linkUrl = ['(?<season>[0-9]+)'];
  r = validatePack(q);
  assert.ok(r.errors.some((e) => e.startsWith('episodes.linkUrl[0]')));
  const s = example(); s.title.slugUrl = '/x/([a-z]+)';
  r = validatePack(s);
  assert.ok(r.errors.some((e) => e.startsWith('title.slugUrl')));
});

test('rejects unknown action', () => {
  const p = example(); p.block[0].action = 'redirect';
  const r = validatePack(p);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('block[0].action')));
});

test('rejects more than 20 block rules', () => {
  const p = example();
  p.block = Array.from({ length: 21 }, (_, i) => ({ urlFilter: `||a${i}.example.com^`, action: 'block' }));
  const r = validatePack(p);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('block')));
});

test('rejects unknown top-level and nested fields', () => {
  const p = example(); p.extra = 1;
  assert.ok(validatePack(p).errors.some((e) => e.startsWith('extra')));
  const q = example(); q.player.nope = 1;
  assert.ok(validatePack(q).errors.some((e) => e.startsWith('player.nope')));
});

test('validates hosts', () => {
  for (const h of ['http://example.com', 'example.com/x', 'example.com:80', 'a b.com', 'Example.com', '']) {
    const p = example(); p.hosts = [h];
    const r = validatePack(p);
    assert.strictEqual(r.ok, false, h);
    assert.ok(r.errors.some((e) => e.startsWith('hosts[0]')));
  }
  const p = example(); p.hosts = [];
  assert.strictEqual(validatePack(p).ok, false);
});

test('rejects bad version, schema, non-object and oversize', () => {
  const p = example(); p.version = '1.0';
  assert.ok(validatePack(p).errors.some((e) => e.startsWith('version')));
  const q = example(); q.schema = 2;
  assert.ok(validatePack(q).errors.some((e) => e.startsWith('schema')));
  assert.strictEqual(validatePack(null).ok, false);
  assert.strictEqual(validatePack([]).ok, false);
  const big = example(); big.title.strip = Array.from({ length: 100 }, () => 'a'.repeat(1000));
  assert.ok(validatePack(big).errors.some((e) => e.includes('64 KB')));
});
