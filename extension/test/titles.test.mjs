import test from 'node:test';
import assert from 'node:assert';
import { parsePage, parseEpisode, seriesKey, collectEpisodes, cleanName } from '../lib/titles.js';

test('episode page', () => {
  const r = parsePage({
    url: 'https://video.example/watch/show-name-part',
    title: 'Show Name 2. Sezon 6. Bölüm İzle | Example',
    ogTitle: 'Show Name 2. Sezon 6. Bölüm İzle | Example',
    h1: '6. Bölüm',
  });
  assert.deepStrictEqual(r, { kind: 'episode', name: 'Show Name', season: 2, episode: 6, year: null });
});

test('movie page', () => {
  const r = parsePage({
    url: 'https://film.example/movie-name-2026/',
    title: 'Movie Name izle | Example | Film izle | HD Film izle',
  });
  assert.deepStrictEqual(r, { kind: 'movie', name: 'Movie Name', season: null, episode: null, year: 2026 });
});

test('movie with year in title and dublaj words', () => {
  const r = parsePage({ url: 'https://x.test/film/dune', title: 'Dune: Part Three (2026) Türkçe Dublaj Full HD İzle' });
  assert.strictEqual(r.name, 'Dune: Part Three');
  assert.strictEqual(r.year, 2026);
});

test('parseEpisode patterns', () => {
  assert.deepStrictEqual(parseEpisode('https://a.test/watch', 'Show 3. Sezon 12. Bölüm'), { season: 3, episode: 12 });
  assert.strictEqual(parseEpisode('https://a.test/dizi/x/3-sezon/12-bolum', ''), null);
  assert.deepStrictEqual(parseEpisode('https://a.test/show/x-s02e05', ''), { season: 2, episode: 5 });
  assert.deepStrictEqual(parseEpisode('https://a.test/watch', 'Show Season 1 Episode 9'), { season: 1, episode: 9 });
  assert.strictEqual(parseEpisode('https://a.test/movie-name-2026/', 'Movie Name'), null);
});

test('seriesKey and collectEpisodes', () => {
  const page = 'https://video.example/series/show-name/season-2/episode-6';
  assert.strictEqual(seriesKey(page), 'video.example/series/show-name');
  const eps = collectEpisodes(page, [
    { href: 'https://video.example/series/show-name/season-2/episode-7', text: '7' },
    { href: 'https://video.example/series/show-name/season-1/episode-1', text: '1' },
    { href: 'https://video.example/series/other/season-2/episode-1', text: 'x' },
    { href: 'https://video.example/series/show-name/season-2/episode-7#c', text: 'dup' },
    { href: 'https://video.example/new', text: 'New' },
  ]);
  assert.deepStrictEqual(eps.map(e => `${e.season}x${e.episode}`), ['1x1', '2x7']);
});

test('cleanName strips site noise', () => {
  assert.strictEqual(cleanName('Show Name 1. Sezon 2. Bölüm Türkçe Altyazılı İzle - Example'), 'Show Name');
});

// ---------- pack-based behavior ----------

const pack = {
  schema: 1, id: 'demo', name: 'Demo', version: '1.0.0', hosts: ['video.example'],
  title: {
    strip: ['\\s*-\\s*Demo Site\\s*$'],
    episodeUrl: ['/show/(?<slug>[^/]+)/(?<season>\\d+)-s/(?<episode>\\d+)-e'],
    slugUrl: '/show/(?<slug>[^/]+)/',
    yearUrl: '-(?<year>\\d{4})/?$',
  },
  episodes: { linkUrl: ['/show/[^/]+/(?<season>\\d+)-s/(?<episode>\\d+)-e'] },
};

test('generic SxxEyy without pack', () => {
  const r = parsePage({ url: 'https://a.test/watch/show-s02e05', title: 'Show S02E05' });
  assert.strictEqual(r.kind, 'episode');
  assert.strictEqual(r.season, 2);
  assert.strictEqual(r.episode, 5);
  assert.deepStrictEqual(parseEpisode('https://a.test/show/season-3-episode-4', ''), { season: 3, episode: 4 });
});

test('pack episodeUrl gives season/episode', () => {
  const url = 'https://video.example/show/the-show/2-s/6-e';
  assert.strictEqual(parseEpisode(url, ''), null);
  assert.deepStrictEqual(parseEpisode(url, '', pack), { season: 2, episode: 6 });
  const r = parsePage({ url, title: '' }, pack);
  assert.deepStrictEqual(r, { kind: 'episode', name: 'The Show', season: 2, episode: 6, year: null });
});

test('pack strip removes site suffix', () => {
  assert.strictEqual(cleanName('Great Show - Demo Site', pack), 'Great Show');
  const r = parsePage({ url: 'https://video.example/show/x/1-s/1-e', title: 'Great Show - Demo Site' }, pack);
  assert.strictEqual(r.name, 'Great Show');
});

test('pack slugUrl name fallback', () => {
  const r = parsePage({ url: 'https://video.example/show/some-long-name/', title: '' }, pack);
  assert.strictEqual(r.name, 'Some Long Name');
});

test('pack yearUrl gives movie year', () => {
  const r = parsePage({ url: 'https://video.example/film-2024/', title: 'Film' }, pack);
  assert.strictEqual(r.year, 2024);
});

test('seriesKey with pack slugUrl', () => {
  assert.strictEqual(seriesKey('https://www.video.example/show/The-Show/2-s/6-e', pack), 'video.example/the-show');
});

test('collectEpisodes uses pack linkUrl and same series key', () => {
  const page = 'https://video.example/show/the-show/2-s/6-e';
  const eps = collectEpisodes(page, [
    { href: 'https://video.example/show/the-show/2-s/7-e', text: '7' },
    { href: 'https://video.example/show/the-show/1-s/1-e', text: '1' },
    { href: 'https://video.example/show/other/2-s/1-e', text: 'x' },
    { href: 'https://video.example/show/the-show/2-s/7-e#c', text: 'dup' },
  ], pack);
  assert.deepStrictEqual(eps.map(e => `${e.season}x${e.episode}`), ['1x1', '2x7']);
});

// Flat addresses: "/<slug>[-<season>-part]-<episode>-ep-watch", the series page under "/show/".
const flat = {
  schema: 1, id: 'flat', name: 'Flat', version: '1.0.0', hosts: ['flat.example'],
  title: {
    episodeUrl: ['(?:-(?<season>\\d{1,2})-part)?-(?<episode>\\d{1,4})-ep-watch(?:-[a-z0-9]+)?/?$'],
    slugUrl: '^/(?:show/)?(?<slug>[^/]+?)(?:-\\d{1,2}-part)?(?:-\\d{1,4}-ep)?-watch(?:-[a-z0-9]+)?/?$',
  },
};

test('pack episodeUrl with an optional season group: no season means season 1', () => {
  assert.deepStrictEqual(parseEpisode('https://flat.example/some-show-2024-7-ep-watch', '', flat), { season: 1, episode: 7 });
  assert.deepStrictEqual(parseEpisode('https://flat.example/some-show-2024-2-part-7-ep-watch-1', '', flat), { season: 2, episode: 7 });
  assert.strictEqual(parseEpisode('https://flat.example/show/some-show-2024-watch-1', '', flat), null);
});

test('flat addresses share one series key with and without a season', () => {
  const key = seriesKey('https://flat.example/show/Some-Show-2024-watch-1', flat);
  assert.strictEqual(key, 'flat.example/some-show-2024');
  assert.strictEqual(seriesKey('https://flat.example/some-show-2024-7-ep-watch', flat), key);
  assert.strictEqual(seriesKey('https://flat.example/show/some-show-2024-2-part-watch', flat), key);
  assert.strictEqual(seriesKey('https://flat.example/some-show-2024-2-part-7-ep-watch', flat), key);
  const eps = collectEpisodes('https://flat.example/show/Some-Show-2024-watch-1', [
    { href: 'https://flat.example/some-show-2024-1-ep-watch', text: '1' },
    { href: 'https://flat.example/some-show-2024-12-ep-watch', text: '12' },
    { href: 'https://flat.example/some-show-2024-2-part-1-ep-watch', text: 's2 1' },
    { href: 'https://flat.example/some-show-3-ep-watch', text: 'other series' },
  ], flat);
  assert.deepStrictEqual(eps.map(e => `${e.season}x${e.episode}`), ['1x1', '1x12', '2x1']);
});
