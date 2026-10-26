import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { groupJobs, stepStates, subLine, summaryLine, dots, folderName, seasonKey, resolveOrder } from '../lib/season.js';

const require = createRequire(import.meta.url);

const NOW = 1_000_000;
const group = { key: 'Show/S1', name: 'Show', season: 1, count: 8 };

function job(ep, state, extra = {}) {
  return {
    id: 'j' + ep,
    createdAt: 100 + ep,
    state,
    step: 'page',
    stepError: null,
    group,
    meta: { kind: 'episode', name: 'Show', season: 1, episode: ep },
    resolve: null,
    progress: { percent: 0 },
    ...extra,
  };
}

function sample() {
  return [
    job(1, 'done', { step: 'done', progress: { percent: 100 } }),
    job(2, 'downloading', { step: 'download', progress: { percent: 38 } }),
    job(3, 'resolving', { step: 'video', resolve: { attempts: 1, startedAt: NOW - 18000, deadlineMs: 90000, note: 'waiting_player' } }),
    job(4, 'failed', { step: 'video', stepError: 'video' }),
    job(5, 'resolving', { resolve: { attempts: 0, startedAt: null, deadlineMs: 90000, note: null } }),
    job(6, 'resolving', { resolve: { attempts: 0, startedAt: null, deadlineMs: 90000, note: null } }),
    job(7, 'resolving', { resolve: { attempts: 0, startedAt: null, deadlineMs: 90000, note: null } }),
    job(8, 'resolving', { resolve: { attempts: 0, startedAt: null, deadlineMs: 90000, note: null } }),
  ];
}

const movie = { id: 'm1', createdAt: 5, state: 'queued', step: 'download', stepError: null, group: null, meta: { kind: 'movie', name: 'Film' } };

function first() {
  const { groups } = groupJobs([...sample(), movie]);
  return groups[0];
}

test('groupJobs orders and counts', () => {
  const { groups, others } = groupJobs([...sample(), movie]);
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].jobs.map((j) => j.meta.episode), [2, 3, 4, 1, 5, 6, 7, 8]);
  assert.deepStrictEqual(groups[0].counts, { done: 1, active: 1, finding: 1, failed: 1, queued: 4 });
  assert.strictEqual(groups[0].key, 'Show/S1');
  assert.strictEqual(groups[0].allDone, false);
  assert.strictEqual(others.length, 1);
});

test('groupJobs puts newest group and newest other first; allDone', () => {
  const g2 = { key: 'Other/S2', name: 'Other', season: 2, count: 1 };
  const a = job(1, 'done', { id: 'x', group: g2, createdAt: 9999 });
  const o1 = { ...movie, id: 'o1', createdAt: 1 };
  const o2 = { ...movie, id: 'o2', createdAt: 2 };
  const { groups, others } = groupJobs([...sample(), a, o1, o2]);
  assert.deepStrictEqual(groups.map((g) => g.key), ['Other/S2', 'Show/S1']);
  assert.strictEqual(groups[0].allDone, true);
  assert.deepStrictEqual(others.map((j) => j.id), ['o2', 'o1']);
});

test('stepStates', () => {
  const by = (ep) => first().jobs.find((j) => j.meta.episode === ep);
  assert.deepStrictEqual(stepStates(by(2)), { page: 'done', video: 'done', download: 'now', mux: '', done: '' });
  assert.deepStrictEqual(stepStates(by(4)), { page: 'done', video: 'err', download: '', mux: '', done: '' });
  assert.deepStrictEqual(stepStates(by(5)), { page: '', video: '', download: '', mux: '', done: '' });
  assert.deepStrictEqual(stepStates(by(1)), { page: 'done', video: 'done', download: 'done', mux: 'done', done: 'done' });
  assert.deepStrictEqual(stepStates(by(3)), { page: 'done', video: 'now', download: '', mux: '', done: '' });
  assert.deepStrictEqual(stepStates(job(9, 'muxing', { step: 'mux' })), { page: 'done', video: 'done', download: 'done', mux: 'now', done: '' });
  assert.deepStrictEqual(stepStates(job(9, 'queued', { step: 'download' })), { page: 'done', video: 'done', download: '', mux: '', done: '' });
});

test('subLine', () => {
  const by = (ep) => first().jobs.find((j) => j.meta.episode === ep);
  const g = first();
  assert.deepStrictEqual(subLine(by(5), g, NOW), { key: 'queued_behind', params: { n: 2 } });
  assert.deepStrictEqual(subLine(by(3), g, NOW), { key: 'resolve_waiting', params: { sec: 18, max: 90 } });
  assert.strictEqual(subLine(by(2), g, NOW), null);
  assert.strictEqual(subLine(by(4), g, NOW), null);
  const short = job(3, 'resolving', { step: 'video', resolve: { attempts: 1, startedAt: NOW - 5000, deadlineMs: 60000, note: 'short_only' } });
  assert.deepStrictEqual(subLine(short, g, NOW), { key: 'resolve_short_only', params: { sec: 5, max: 60 } });
  const opening = job(3, 'resolving', { step: 'page', resolve: { attempts: 1, startedAt: NOW - 1000, deadlineMs: 60000, note: 'opening' } });
  assert.deepStrictEqual(subLine(opening, g, NOW), { key: 'resolve_opening', params: {} });
  const q = job(6, 'queued', { step: 'download' });
  assert.deepStrictEqual(subLine(q, g, NOW), { key: 'queued_behind', params: { n: 3 } });
});

test('summaryLine open', () => {
  assert.deepStrictEqual(summaryLine(first(), false), {
    key: 'season_sum',
    parts: [
      { key: 'season_sum_done', params: { n: 1 } },
      { key: 'season_sum_active', params: { n: 1 } },
      { key: 'season_sum_finding', params: { n: 1 } },
      { key: 'season_sum_failed', params: { n: 1 } },
      { key: 'season_sum_queued', params: { n: 4 } },
    ],
  });
});

test('summaryLine open skips zero counts', () => {
  const { groups } = groupJobs([job(1, 'done'), job(2, 'queued')]);
  assert.deepStrictEqual(summaryLine(groups[0], false).parts, [
    { key: 'season_sum_done', params: { n: 1 } },
    { key: 'season_sum_queued', params: { n: 1 } },
  ]);
});

test('summaryLine folded', () => {
  assert.deepStrictEqual(summaryLine(first(), true), {
    key: 'season_sum',
    parts: [
      { key: 'ep_sum_downloading', params: { n: 2, pct: 38 } },
      { key: 'ep_sum_finding', params: { n: 3 } },
      { key: 'ep_sum_failed', params: { n: 4 } },
    ],
  });
});

test('summaryLine folded adds a more entry', () => {
  const jobs = [1, 2, 3, 4, 5].map((ep) => job(ep, 'failed', { stepError: 'video' }));
  const { groups } = groupJobs(jobs);
  const parts = summaryLine(groups[0], true).parts;
  assert.strictEqual(parts.length, 4);
  assert.deepStrictEqual(parts[3], { key: 'ep_sum_more', params: { n: 2 } });
});

test('dots', () => {
  assert.deepStrictEqual(dots(first()), ['done', 'active', 'active', 'failed', 'queued', 'queued', 'queued', 'queued']);
});

test('paused and canceled cards', () => {
  const paused = job(2, 'paused', { step: 'download', progress: { percent: 40 } });
  const canceled = job(3, 'canceled', { step: 'video', stepError: 'video' });
  const { groups } = groupJobs([paused, canceled]);
  assert.deepStrictEqual(groups[0].counts, { done: 0, active: 1, finding: 0, failed: 1, queued: 0 });
  assert.deepStrictEqual(stepStates(paused), { page: 'done', video: 'done', download: 'now', mux: '', done: '' });
  assert.deepStrictEqual(stepStates(canceled), { page: 'done', video: 'err', download: '', mux: '', done: '' });
  assert.strictEqual(subLine(paused, groups[0], NOW), null);
});

test('folded summary names muxing and paused episodes', () => {
  const muxing = job(2, 'muxing', { step: 'mux', progress: { percent: 10 } });
  const paused = job(3, 'paused', { step: 'download', progress: { percent: 40 } });
  const { groups } = groupJobs([muxing, paused]);
  assert.deepStrictEqual(summaryLine(groups[0], true).parts.map((p) => p.key), ['ep_sum_muxing', 'ep_sum_paused']);
});

test('subLine counter: default deadline, clamped seconds', () => {
  const r = (startedAt, deadlineMs) => ({ attempts: 1, startedAt, deadlineMs, note: 'waiting_player' });
  const noDeadline = job(3, 'resolving', { step: 'video', resolve: r(NOW - 5000, null) });
  assert.deepStrictEqual(subLine(noDeadline, null, NOW).params, { sec: 5, max: 90 });
  const late = job(3, 'resolving', { step: 'video', resolve: r(NOW - 400000, 90000) });
  assert.deepStrictEqual(subLine(late, null, NOW).params, { sec: 90, max: 90 });
  const early = job(3, 'resolving', { step: 'video', resolve: r(NOW + 3000, 90000) });
  assert.strictEqual(subLine(early, null, NOW).params.sec, 0);
});

test('a card without an episode number sorts last and waits behind the others', () => {
  const noEp = job(0, 'resolving', { id: 'x', meta: { kind: 'episode', name: 'Show', season: 1 } });
  const e2 = job(2, 'resolving');
  const e5 = job(5, 'resolving');
  const { groups } = groupJobs([noEp, e5, e2]);
  assert.deepStrictEqual(groups[0].jobs.map((j) => j.id), ['j2', 'j5', 'x']);
  assert.strictEqual(subLine(noEp, groups[0], NOW).params.n, 2);
  assert.strictEqual(subLine(e2, groups[0], NOW).params.n, 0);
  assert.deepStrictEqual(dots(groups[0]).length, 3);
});

test('group takes the newest card name and the largest count', () => {
  const old = job(1, 'done', { createdAt: 1, group: { ...group, name: 'show', count: 3 } });
  const neu = job(2, 'resolving', { createdAt: 9, group: { ...group, name: 'Show', count: 10 } });
  const lone = job(3, 'resolving', { createdAt: 5, group: { ...group, count: undefined } });
  const g = groupJobs([old, neu, lone]).groups[0];
  assert.strictEqual(g.name, 'Show');
  assert.strictEqual(g.count, 10);
  assert.strictEqual(groupJobs([lone]).groups[0].count, 1);
});

test('folderName is the same as the helper sanitize()', () => {
  const { sanitize } = require('../../helper/lib/names.js');
  const names = ['MobLand', 'A: B / C?', '  Show.  ', 'con', 'COM1', 'Tab\there', 'x'.repeat(200), '', 'Ünlü Dizi *2*', 'a<b>c|d"e'];
  for (const n of names) assert.strictEqual(folderName(n), sanitize(n), JSON.stringify(n));
  assert.strictEqual(seasonKey('A: B', 2), 'A B/S2');
});

test('resolveOrder: season 2 before season 10, then episodes', () => {
  const g = (season) => ({ key: seasonKey('Show', season), name: 'Show', season, count: 1 });
  const jobs = [job(1, 'resolving', { id: 's10e1', group: g(10) }), job(2, 'resolving', { id: 's2e2', group: g(2) }),
    job(1, 'resolving', { id: 's2e1', group: g(2) })];
  assert.deepStrictEqual(jobs.sort(resolveOrder).map((j) => j.id), ['s2e1', 's2e2', 's10e1']);
});
