import test from 'node:test';
import assert from 'node:assert';
import { epId, createFollow, diffFollow, toNotify, markNotified, prunePending, dismiss, followOptions } from '../lib/follow.js';

const ep = (season, episode, host = 'site.test') => ({ season, episode, url: `https://${host}/dizi/demo/sezon-${season}/bolum-${episode}/` });
const base = () => createFollow({ url: 'https://site.test/dizi/demo/', name: 'Demo', key: 'site.test/dizi/demo', episodes: [ep(1, 1), ep(1, 2), ep(1, 3)], now: 1000 });

test('createFollow marks every listed episode as seen', () => {
  const f = base();
  assert.deepStrictEqual(f.seen, ['1x1', '1x2', '1x3']);
  assert.deepStrictEqual(f.pending, []);
  assert.deepStrictEqual(f.notified, []);
  assert.strictEqual(f.urls['1x2'], ep(1, 2).url);
  assert.strictEqual(f.lastCheck, 1000);
  assert.strictEqual(f.lastError, null);
  assert.ok(f.id);
  assert.strictEqual(epId(2, 5), '2x5');
});

test('diffFollow finds new episodes and a new season', () => {
  const { follow, added } = diffFollow(base(), [ep(2, 1), ep(1, 1), ep(1, 2), ep(1, 3), ep(1, 4)], 2000);
  assert.deepStrictEqual(added.map(e => epId(e.season, e.episode)), ['1x4', '2x1']);
  assert.strictEqual(follow.pending.length, 2);
  assert.ok(follow.seen.includes('2x1'));
  assert.strictEqual(follow.lastCheck, 2000);
});

test('diffFollow counts a late episode in an old season as new', () => {
  const f = createFollow({ url: 'u', name: 'Demo', key: 'k', episodes: [ep(1, 1), ep(1, 3)], now: 1 });
  const { added } = diffFollow(f, [ep(1, 1), ep(1, 2), ep(1, 3)], 2);
  assert.deepStrictEqual(added.map(e => epId(e.season, e.episode)), ['1x2']);
});

test('diffFollow with an empty list adds nothing and records the error', () => {
  const f = base();
  const { follow, added } = diffFollow(f, [], 3000);
  assert.deepStrictEqual(added, []);
  assert.strictEqual(follow.lastError, 'empty');
  assert.deepStrictEqual(follow.seen, f.seen);
  assert.strictEqual(follow.lastCheck, 3000);
});

test('diffFollow refreshes the address of a known episode', () => {
  const { follow, added } = diffFollow(base(), [ep(1, 1, 'new.test'), ep(1, 2), ep(1, 3)], 2);
  assert.deepStrictEqual(added, []);
  assert.strictEqual(follow.urls['1x1'], ep(1, 1, 'new.test').url);
});

test('diffFollow does not change the record it was given', () => {
  const f = base();
  const copy = JSON.stringify(f);
  diffFollow(f, [ep(1, 4)], 2);
  assert.strictEqual(JSON.stringify(f), copy);
});

test('toNotify and markNotified announce an episode once', () => {
  let { follow } = diffFollow(base(), [ep(1, 1), ep(1, 2), ep(1, 3), ep(1, 4)], 2);
  const first = toNotify(follow);
  assert.deepStrictEqual(first.map(e => epId(e.season, e.episode)), ['1x4']);
  follow = markNotified(follow, first.map(e => epId(e.season, e.episode)));
  // The next check sees the same page: nothing new, nothing to announce again.
  ({ follow } = diffFollow(follow, [ep(1, 1), ep(1, 2), ep(1, 3), ep(1, 4)], 3));
  assert.deepStrictEqual(toNotify(follow), []);
  assert.strictEqual(follow.pending.length, 1, '"Not now" keeps the episode on the card');
});

test('prunePending drops episodes that are in the queue in any state', () => {
  let { follow } = diffFollow(base(), [ep(1, 4), ep(1, 5), ep(2, 1)], 2);
  const job = (name, season, episode, state) => ({ state, group: { key: `${name}/S${season}` }, meta: { episode } });
  follow = prunePending(follow, [job('Demo', 1, 4, 'failed'), job('Demo', 2, 1, 'done'), job('Other', 1, 5, 'queued')]);
  assert.deepStrictEqual(follow.pending.map(e => epId(e.season, e.episode)), ['1x5']);
});

test('dismiss removes from pending, keeps seen', () => {
  let { follow } = diffFollow(base(), [ep(1, 4)], 2);
  follow = dismiss(follow, '1x4');
  assert.deepStrictEqual(follow.pending, []);
  assert.ok(follow.seen.includes('1x4'));
});

test('followOptions uses the stored defaults', () => {
  assert.deepStrictEqual(followOptions({ defaults: { quality: 720, subLangs: ['tr'] } }, 'en', 'Demo'),
    { name: 'Demo', height: 720, subtitlesOnly: false, embedSubs: { lang: 'tr', keepSrt: true } });
  assert.deepStrictEqual(followOptions({}, 'tr', 'Demo'),
    { name: 'Demo', height: null, subtitlesOnly: false, embedSubs: { lang: 'tr', keepSrt: true } });
});

test('latestUrl gives the address of the newest known episode', async () => {
  const { latestUrl } = await import('../lib/follow.js');
  const { follow } = diffFollow(base(), [ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1), ep(1, 10)], 2);
  assert.strictEqual(latestUrl(follow), ep(2, 1).url);
  assert.strictEqual(latestUrl({ urls: {} }), null);
});

test('sameSeries: a domain move is the same series, another slug is not', async () => {
  const { sameSeries } = await import('../lib/follow.js');
  assert.strictEqual(sameSeries('old.test/dizi/demo', 'new.test/dizi/demo'), true);
  assert.strictEqual(sameSeries('site.test/dizi/demo', 'site.test/dizi/other'), false);
  assert.strictEqual(sameSeries('site.test/dizi/demo', ''), false);
});

test('prunePending drops an episode downloaded from its own page (a job without a group)', () => {
  let { follow } = diffFollow(base(), [ep(1, 4), ep(1, 5)], 2);
  follow = prunePending(follow, [{ state: 'done', group: null, pageUrl: ep(1, 4).url, meta: { kind: 'episode', episode: 4 } }]);
  assert.deepStrictEqual(follow.pending.map(e => epId(e.season, e.episode)), ['1x5']);
});
