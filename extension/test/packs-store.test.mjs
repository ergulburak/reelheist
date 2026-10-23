import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { createStore, matchHost } from '../lib/packs/store.js';
import { sha256Hex } from '../lib/packs/verify.js';

const enc = (s) => new TextEncoder().encode(s);

function memStorage() {
  const d = {};
  return {
    d,
    async get(keys) {
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
      const out = {};
      for (const k of list) if (k in d) out[k] = structuredClone(d[k]);
      return out;
    },
    async set(o) { for (const [k, v] of Object.entries(o)) d[k] = structuredClone(v); },
    async remove(keys) { for (const k of [].concat(keys)) delete d[k]; },
  };
}

function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
}

function fakeFetch(files) {
  return async (url) => {
    if (!(url in files)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const v = files[url];
    if (v instanceof Error) throw v;
    const bytes = typeof v === 'string' ? enc(v) : v;
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
}

const ROOT = 'https://packs.test/repo';

async function publish(files, key, pack, { root = ROOT, name = 'Test repo', tamper } = {}) {
  const text = JSON.stringify(pack);
  const bytes = enc(text);
  files[`${root}/repo.json`] = JSON.stringify({ schema: 1, name, publicKey: key.pub });
  const idx = files[`${root}/index.json`] ? JSON.parse(files[`${root}/index.json`]) : { schema: 1, packs: [] };
  idx.packs = idx.packs.filter((p) => p.id !== pack.id);
  idx.packs.push({ id: pack.id, name: pack.name, version: pack.version, hosts: pack.hosts, file: `packs/${pack.id}.json`, sha256: await sha256Hex(bytes) });
  files[`${root}/index.json`] = JSON.stringify(idx);
  files[`${root}/packs/${pack.id}.json`] = tamper ? enc(text.replace(pack.name, pack.name + 'X')) : bytes;
  files[`${root}/packs/${pack.id}.json.sig`] = crypto.sign(null, bytes, key.privateKey).toString('base64');
}

const pk = (over = {}) => ({ schema: 1, id: 'demo', name: 'Demo', version: '1.0.0', hosts: ['sitead*.com', '*.example.com'], ...over });

async function setup(pack = pk(), opts) {
  const files = {};
  const key = makeKey();
  await publish(files, key, pack, opts);
  const storage = memStorage();
  const store = createStore({ storage, fetch: fakeFetch(files) });
  return { files, key, storage, store };
}

test('matchHost', () => {
  assert.strictEqual(matchHost('sitead*.com', 'sitead1823.com'), true);
  assert.strictEqual(matchHost('*.example.com', 'www.example.com'), true);
  assert.strictEqual(matchHost('*.example.com', 'example.com'), false);
  assert.strictEqual(matchHost('a*.com', 'evil.com/a.com'), false);
  assert.strictEqual(matchHost('Example.com', 'EXAMPLE.com'), true);
  assert.strictEqual(matchHost('*.example.com', 'a.b.example.com'), false);
});

test('addRepo returns untrusted repo with fingerprint; URL forms normalized', async () => {
  const { store } = await setup();
  const r = await store.addRepo(ROOT + '/repo.json');
  assert.strictEqual(r.url, ROOT);
  assert.strictEqual(r.name, 'Test repo');
  assert.strictEqual(r.trusted, false);
  assert.match(r.fingerprint, /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
  assert.strictEqual((await store.addRepo(ROOT + '/')).url, ROOT);
  assert.strictEqual((await store.addRepo(ROOT + '/index.json')).url, ROOT);
});

test('invalid repo URLs rejected', async () => {
  const { store } = await setup();
  for (const u of ['file:///etc/x', 'http://evil.test/r', 'ftp://x.test', 'nonsense', '']) {
    await assert.rejects(store.addRepo(u), { code: 'repo_invalid' });
  }
});

test('404 repo.json gives repo_unreachable', async () => {
  const { store } = await setup();
  await assert.rejects(store.addRepo('https://nowhere.test/x'), { code: 'repo_unreachable' });
});

test('network error gives repo_unreachable', async () => {
  const store = createStore({ storage: memStorage(), fetch: fakeFetch({ 'https://n.test/r/repo.json': new Error('boom') }) });
  await assert.rejects(store.addRepo('https://n.test/r'), { code: 'repo_unreachable' });
});

test('malformed repo.json or key gives repo_invalid', async () => {
  const files = { 'https://a.test/r/repo.json': '{"schema":1,"name":"x","publicKey":"!!!"}', 'https://b.test/r/repo.json': 'not json' };
  const store = createStore({ storage: memStorage(), fetch: fakeFetch(files) });
  await assert.rejects(store.addRepo('https://a.test/r'), { code: 'repo_invalid' });
  await assert.rejects(store.addRepo('https://b.test/r'), { code: 'repo_invalid' });
});

test('untrusted repo cannot install', async () => {
  const { store } = await setup();
  await store.addRepo(ROOT);
  await assert.rejects(store.installPack(ROOT, 'demo'), { code: 'repo_untrusted' });
  assert.deepStrictEqual(await store.installedPacks(), []);
});

test('trusted repo installs; listAvailable works; pack_not_found', async () => {
  const { store } = await setup();
  await store.addRepo(ROOT);
  await store.trustRepo(ROOT);
  assert.strictEqual((await store.listAvailable(ROOT))[0].id, 'demo');
  const p = await store.installPack(ROOT, 'demo');
  assert.strictEqual(p.id, 'demo');
  assert.strictEqual((await store.installedPacks()).length, 1);
  await assert.rejects(store.installPack(ROOT, 'nope'), { code: 'pack_not_found' });
  await store.uninstallPack('demo');
  assert.strictEqual((await store.installedPacks()).length, 0);
});

test('hash mismatch keeps old version', async () => {
  const { store, files, key } = await setup();
  await store.addRepo(ROOT);
  await store.trustRepo(ROOT);
  await store.installPack(ROOT, 'demo');
  await publish(files, key, pk({ version: '1.1.0' }), { tamper: true });
  await assert.rejects(store.installPack(ROOT, 'demo'), { code: 'pack_hash' });
  assert.strictEqual((await store.installedPacks())[0].version, '1.0.0');
});

test('bad signature rejected with pack_signature', async () => {
  const { store, files } = await setup();
  await store.addRepo(ROOT);
  await store.trustRepo(ROOT);
  const other = makeKey();
  files[`${ROOT}/packs/demo.json.sig`] = crypto.sign(null, files[`${ROOT}/packs/demo.json`], other.privateKey).toString('base64');
  await assert.rejects(store.installPack(ROOT, 'demo'), { code: 'pack_signature' });
  assert.deepStrictEqual(await store.installedPacks(), []);
});

test('schema errors give pack_invalid with errors; over-broad hosts rejected', async () => {
  for (const hosts of [['*'], ['*.*'], ['*.com'], ['a b']]) {
    const { store } = await setup(pk({ hosts }));
    await store.addRepo(ROOT);
    await store.trustRepo(ROOT);
    await assert.rejects(store.installPack(ROOT, 'demo'), (e) => e.code === 'pack_invalid' && Array.isArray(e.errors) && e.errors.length > 0);
  }
  const { store } = await setup(pk({ version: 'x' }));
  await store.addRepo(ROOT);
  await store.trustRepo(ROOT);
  await assert.rejects(store.installPack(ROOT, 'demo'), { code: 'pack_invalid' });
});

test('removeRepo uninstalls its packs', async () => {
  const { store, storage } = await setup();
  await store.addRepo(ROOT);
  await store.trustRepo(ROOT);
  await store.installPack(ROOT, 'demo');
  await store.removeRepo(ROOT);
  assert.deepStrictEqual(await store.installedPacks(), []);
  assert.deepStrictEqual(storage.d.packRepos, []);
});

test('packForUrl prefers user choice, else earliest installed', async () => {
  const files = {};
  const key = makeKey();
  await publish(files, key, pk({ id: 'one', hosts: ['*.example.com'] }));
  await publish(files, key, pk({ id: 'two', hosts: ['www.example.com'] }));
  const storage = memStorage();
  const store = createStore({ storage, fetch: fakeFetch(files) });
  await store.addRepo(ROOT);
  await store.trustRepo(ROOT);
  await store.installPack(ROOT, 'one');
  await new Promise((r) => setTimeout(r, 5));
  await store.installPack(ROOT, 'two');
  assert.strictEqual((await store.packForUrl('https://www.example.com/a')).id, 'one');
  await storage.set({ preferredPack: { 'www.example.com': 'two' } });
  assert.strictEqual((await store.packForUrl('https://www.example.com/a')).id, 'two');
  assert.strictEqual(await store.packForUrl('https://other.test/'), null);
  assert.strictEqual(await store.packForUrl('not a url'), null);
});

test('updateAll installs newer versions and reports failures', async () => {
  const { store, files, key } = await setup();
  await store.addRepo(ROOT);
  await store.trustRepo(ROOT);
  await store.installPack(ROOT, 'demo');
  assert.deepStrictEqual(await store.updateAll(), { updated: [], failed: [] });
  await publish(files, key, pk({ version: '1.2.0' }));
  assert.deepStrictEqual(await store.updateAll(), { updated: ['demo'], failed: [] });
  assert.strictEqual((await store.installedPacks())[0].version, '1.2.0');
  await publish(files, key, pk({ version: '1.3.0' }), { tamper: true });
  assert.deepStrictEqual(await store.updateAll(), { updated: [], failed: [{ id: 'demo', code: 'pack_hash' }] });
  assert.strictEqual((await store.installedPacks())[0].version, '1.2.0');
});

test('update keeps original installedAt so packForUrl default does not change', async () => {
  const files = {};
  const key = makeKey();
  await publish(files, key, pk({ id: 'one', hosts: ['*.example.com'] }));
  await publish(files, key, pk({ id: 'two', hosts: ['www.example.com'] }));
  const store = createStore({ storage: memStorage(), fetch: fakeFetch(files) });
  await store.addRepo(ROOT);
  await store.trustRepo(ROOT);
  await store.installPack(ROOT, 'one');
  await new Promise((r) => setTimeout(r, 5));
  await store.installPack(ROOT, 'two');
  await new Promise((r) => setTimeout(r, 5));
  await publish(files, key, pk({ id: 'one', hosts: ['*.example.com'], version: '1.1.0' }));
  assert.deepStrictEqual((await store.updateAll()).updated, ['one']);
  await store.installPack(ROOT, 'one');
  assert.strictEqual((await store.packForUrl('https://www.example.com/')).id, 'one');
});
