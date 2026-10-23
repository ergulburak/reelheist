import test from 'node:test';
import assert from 'node:assert';
import { buildDynamicRules } from '../lib/packs/dnr.js';

const packA = { id: 'a', block: [{ urlFilter: 'one-detect', action: 'stub' }, { urlFilter: 'two-ads', action: 'block' }] };
const packB = { id: 'b', block: [{ urlFilter: 'three', action: 'stub' }] };

test('two packs → sequential ids from 1000', () => {
  const rules = buildDynamicRules([packA, packB]);
  assert.deepStrictEqual(rules.map(r => r.id), [1000, 1001, 1002]);
  assert.strictEqual(rules[1].action.type, 'block');
  assert.deepStrictEqual(rules[1].condition, { urlFilter: 'two-ads', resourceTypes: ['script'] });
});

test('stub action redirects to /stubs/devtools-noop.js', () => {
  const [r] = buildDynamicRules([packB]);
  assert.deepStrictEqual(r.action, { type: 'redirect', redirect: { extensionPath: '/stubs/devtools-noop.js' } });
});

test('no packs → []', () => {
  assert.deepStrictEqual(buildDynamicRules([]), []);
  assert.deepStrictEqual(buildDynamicRules([{ id: 'x' }]), []);
});

test('ids stay inside 1000–1999', () => {
  const big = { id: 'c', block: Array.from({ length: 20 }, (_, i) => ({ urlFilter: `f${i}`, action: 'block' })) };
  const rules = buildDynamicRules(Array.from({ length: 80 }, () => big));
  assert.strictEqual(rules.length, 1000);
  assert.strictEqual(rules.at(-1).id, 1999);
});
