import test from 'node:test';
import assert from 'node:assert';
import { queueSummary } from '../lib/queue-summary.js';

const j = (id, state, percent) => ({ id, state, progress: percent == null ? null : { percent } });

test('several running jobs: their count, the mean percent and the waiting jobs', () => {
  const s = queueSummary([j('a', 'downloading', 20), j('b', 'muxing', 60), j('c', 'downloading', 40), j('d', 'queued'), j('e', 'done', 100)]);
  assert.deepStrictEqual({ n: s.running.length, pct: s.pct, waiting: s.waiting }, { n: 3, pct: 40, waiting: 1 });
});

test('one running job: that job and its percent', () => {
  const s = queueSummary([j('a', 'queued'), j('b', 'downloading', 33.4)]);
  assert.deepStrictEqual({ first: s.first.id, n: s.running.length, pct: s.pct, waiting: s.waiting }, { first: 'b', n: 1, pct: 33, waiting: 1 });
});

test('only waiting jobs: the first one is shown at 0 percent', () => {
  const s = queueSummary([j('a', 'queued'), j('b', 'queued')]);
  assert.deepStrictEqual({ first: s.first.id, n: s.running.length, pct: s.pct, waiting: s.waiting }, { first: 'a', n: 0, pct: 0, waiting: 1 });
});

test('nothing active: no first job', () => {
  assert.strictEqual(queueSummary([j('a', 'done', 100), j('b', 'failed')]).first, null);
});
