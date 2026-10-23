'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AdaptiveLimiter } = require('../lib/throttle');
const { isValidSegment, runAdaptive } = require('../lib/download');

test('isValidSegment accepts media and rejects junk', () => {
  const ts = Buffer.alloc(188 * 3);
  ts[0] = ts[188] = ts[376] = 0x47;
  assert.ok(isValidSegment(ts, false));
  assert.ok(isValidSegment(Buffer.from('ID3\x04\x00rest', 'latin1'), false));
  assert.ok(isValidSegment(Buffer.from([0xff, 0xf1, 0x50, 0x80]), false));
  assert.ok(isValidSegment(Buffer.from('\x00\x00\x00\x18moofxxxx', 'latin1'), true));
  assert.ok(!isValidSegment(Buffer.from('<html>rate limited</html>'), false));
  assert.ok(!isValidSegment(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), false));
  assert.ok(!isValidSegment(ts, false, 'text/html; charset=utf-8'));
  assert.ok(!isValidSegment(Buffer.alloc(0), false));
  assert.ok(!isValidSegment(Buffer.from('\x00\x00\x00\x18abcdxxxx', 'latin1'), true));
});

test('limiter grows while throughput grows and halves on failure', () => {
  const l = new AdaptiveLimiter({ start: 4, max: 16, windowMs: 1000 });
  let t = Date.now();
  // Throughput scales with connections: limit should climb.
  for (let step = 0; step < 6; step++) {
    for (let i = 0; i < 10; i++) l.success(100 * l.limit, (t += 100));
  }
  assert.ok(l.limit > 4, `limit ${l.limit}`);
  const before = l.limit;
  l.failure(t);
  assert.strictEqual(l.limit, Math.max(2, Math.ceil(before / 2)));
});

test('limiter reverts an increase that does not help', () => {
  const l = new AdaptiveLimiter({ start: 4, max: 16, windowMs: 1000 });
  let t = Date.now();
  for (let step = 0; step < 6; step++) {
    for (let i = 0; i < 10; i++) l.success(1000, (t += 100)); // flat throughput
  }
  assert.ok(l.limit <= 6, `limit ${l.limit}`);
});

test('runAdaptive never exceeds the limit and runs every item', async () => {
  const l = new AdaptiveLimiter({ start: 3, max: 8 });
  let active = 0, peak = 0, ran = 0;
  await runAdaptive(Array.from({ length: 40 }, (_, i) => i), l, async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--; ran++;
  });
  assert.strictEqual(ran, 40);
  assert.ok(peak <= 3, `peak ${peak}`);
});
