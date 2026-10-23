import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyPack, fingerprint, sha256Hex } from '../lib/packs/verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(here, '../../tools/pack-sign.js');
const EXAMPLE = path.resolve(here, '../../packs/example.json');

function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, pub: raw.toString('base64') };
}
const sign = (bytes, key) => crypto.sign(null, bytes, key.privateKey).toString('base64');
const data = () => new TextEncoder().encode('{"hello":"world"}');

test('valid signature verifies', async () => {
  const k = makeKey();
  const bytes = data();
  assert.strictEqual(await verifyPack(bytes, sign(bytes, k), k.pub), true);
});

test('one changed byte fails', async () => {
  const k = makeKey();
  const bytes = data();
  const sig = sign(bytes, k);
  const bad = bytes.slice();
  bad[3] ^= 1;
  assert.strictEqual(await verifyPack(bad, sig, k.pub), false);
});

test('other key fails', async () => {
  const k = makeKey();
  const other = makeKey();
  const bytes = data();
  assert.strictEqual(await verifyPack(bytes, sign(bytes, k), other.pub), false);
});

test('malformed signature or key returns false', async () => {
  const k = makeKey();
  assert.strictEqual(await verifyPack(data(), '!!!not base64!!!', k.pub), false);
  assert.strictEqual(await verifyPack(data(), 'AAAA', 'AAAA'), false);
});

test('fingerprint format', async () => {
  const k = makeKey();
  assert.match(await fingerprint(k.pub), /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
});

test('sha256Hex matches node crypto', async () => {
  const bytes = data();
  assert.strictEqual(await sha256Hex(bytes), crypto.createHash('sha256').update(bytes).digest('hex'));
});

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'packsign-')); }
const run = (...args) => execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: 'pipe' });

test('pack-sign build writes index with matching sha256', async () => {
  const dir = tmp();
  try {
    const repo = path.join(dir, 'myrepo');
    run('keygen', repo);
    assert.ok(fs.existsSync(path.join(repo, 'repo-private.pem')));
    assert.match(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), /^repo-private\.pem$/m);
    const meta = JSON.parse(fs.readFileSync(path.join(repo, 'repo.json'), 'utf8'));
    assert.strictEqual(meta.name, 'myrepo');
    assert.strictEqual(meta.schema, 1);
    fs.mkdirSync(path.join(repo, 'packs'));
    fs.copyFileSync(EXAMPLE, path.join(repo, 'packs', 'example.json'));
    run('build', repo);
    const index = JSON.parse(fs.readFileSync(path.join(repo, 'index.json'), 'utf8'));
    assert.strictEqual(index.schema, 1);
    assert.strictEqual(index.packs.length, 1);
    const e = index.packs[0];
    assert.strictEqual(e.id, 'example');
    assert.strictEqual(e.file, 'packs/example.json');
    const bytes = fs.readFileSync(path.join(repo, e.file));
    assert.strictEqual(e.sha256, await sha256Hex(new Uint8Array(bytes)));
    const sig = fs.readFileSync(path.join(repo, e.file + '.sig'), 'utf8').trim();
    assert.strictEqual(await verifyPack(new Uint8Array(bytes), sig, meta.publicKey), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('keygen refuses to overwrite and keeps repo.json fields', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'repo.json'), JSON.stringify({ schema: 1, name: 'X', website: 'https://e.test' }));
    run('keygen', dir);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'repo.json'), 'utf8'));
    assert.strictEqual(meta.website, 'https://e.test');
    assert.ok(meta.publicKey);
    const r = spawnSync(process.execPath, [TOOL, 'keygen', dir], { encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('build fails on invalid pack, id mismatch and oversize', () => {
  const dir = tmp();
  try {
    run('keygen', dir);
    fs.mkdirSync(path.join(dir, 'packs'));
    const good = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
    const put = (f, o) => fs.writeFileSync(path.join(dir, 'packs', f), typeof o === 'string' ? o : JSON.stringify(o));
    const build = () => spawnSync(process.execPath, [TOOL, 'build', dir], { encoding: 'utf8' });

    put('example.json', { ...good, hosts: 'nope' });
    let r = build();
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /example\.json/);

    put('example.json', { ...good, id: 'other' });
    r = build();
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /example\.json/);

    put('example.json', good);
    put('big.json', JSON.stringify({ ...good, id: 'big', name: 'x'.repeat(70 * 1024) }));
    r = build();
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /big\.json/);
    assert.ok(!fs.existsSync(path.join(dir, 'index.json')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
