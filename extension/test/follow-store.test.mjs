import test from 'node:test';
import assert from 'node:assert';
import { createFollowStore } from '../lib/follow-store.js';
import { createFollow, markNotified } from '../lib/follow.js';

// In-memory chrome.storage.local; a short await keeps reads and writes interleaving like the real one.
function fakeStorage() {
  const data = {};
  const tick = () => new Promise(r => setTimeout(r, 1));
  return {
    data,
    async get(key) { await tick(); return key in data ? { [key]: JSON.parse(JSON.stringify(data[key])) } : {}; },
    async set(obj) { await tick(); for (const [k, v] of Object.entries(obj)) data[k] = JSON.parse(JSON.stringify(v)); },
  };
}

const follow = key => createFollow({ url: `https://s.test/${key}/`, name: key, key, episodes: [{ season: 1, episode: 1, url: 'u' }] });

test('add twice with the same key keeps one follow', async () => {
  const store = createFollowStore(fakeStorage());
  const a = await store.add(follow('demo'));
  const b = await store.add(follow('demo'));
  assert.strictEqual(b.id, a.id);
  assert.strictEqual((await store.list()).length, 1);
  assert.strictEqual((await store.findByKey('demo')).id, a.id);
  assert.strictEqual(await store.findByKey('other'), null);
});

test('update of a removed follow writes nothing', async () => {
  const storage = fakeStorage();
  const store = createFollowStore(storage);
  const a = await store.add(follow('demo'));
  await store.remove(a.id);
  assert.strictEqual(await store.update(a.id, f => ({ ...f, name: 'changed' })), null);
  assert.deepStrictEqual(await store.list(), []);
});

test('parallel updates do not lose writes', async () => {
  const store = createFollowStore(fakeStorage());
  const a = await store.add(follow('demo'));
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.update(a.id, f => markNotified(f, [`1x${i + 2}`]))));
  assert.strictEqual((await store.list())[0].notified.length, 20);
});
