import test from 'node:test';
import assert from 'node:assert';
import { estimateBytes, estimateSeconds, formatBytes, formatDuration } from '../lib/estimate.js';

test('master 1080p 5 Mbps 2520 s + 2 audio ≈ 1.67e9 bytes (±1%)', () => {
  const probe = {
    type: 'master',
    duration: 2520,
    variants: [
      { height: 720, bandwidth: 2_500_000, audioGroup: 'a' },
      { height: 1080, bandwidth: 5_000_000, audioGroup: 'a' },
    ],
    audios: [
      { url: 'https://p.test/a-tr.m3u8', name: 'Türkçe', lang: 'tr', groupId: 'a' },
      { url: 'https://p.test/a-en.m3u8', name: 'English', lang: 'en', groupId: 'a' },
    ],
  };
  const bytes = estimateBytes(probe, { height: 1080, audioLangs: ['tr', 'en'] });
  assert.ok(bytes != null, 'expected non-null byte estimate');
  const target = 1.67e9;
  assert.ok(
    Math.abs(bytes - target) / target <= 0.01,
    `expected ${bytes} to be within ±1% of ${target}`,
  );
});

test('ytdlp sums selected format sizes', () => {
  const probe = {
    type: 'ytdlp',
    duration: 600,
    variants: [
      { height: 1080, codec: 'avc1', size: 120_000_000 },
      { height: 720, codec: 'avc1', size: 60_000_000 },
    ],
    audios: [
      { lang: 'en', name: 'English', original: true, size: 10_000_000 },
      { lang: 'tr', name: 'Turkish', original: false, size: 9_500_000 },
      { lang: 'de', name: 'German', original: false, size: 9_000_000 },
    ],
  };
  assert.strictEqual(
    estimateBytes(probe, { height: 1080, audioLangs: ['en', 'tr'] }),
    139_500_000,
  );
});

test('unknown returns null', () => {
  assert.strictEqual(estimateBytes(null, {}), null);
  assert.strictEqual(estimateBytes({ type: 'file', variants: [], audios: [] }, {}), null);
  assert.strictEqual(estimateBytes({ type: 'master', duration: null, variants: [{ height: 1080, bandwidth: 5_000_000 }], audios: [] }, { height: 1080 }), null);
  assert.strictEqual(estimateBytes({ type: 'ytdlp', variants: [{ height: 1080, size: null }], audios: [] }, { height: 1080 }), null);
});

test('estimateSeconds(1.4e9, 5.6e6) === 250', () => {
  assert.strictEqual(estimateSeconds(1.4e9, 5.6e6), 250);
  assert.strictEqual(estimateSeconds(5e7), 10);
});

test('formatBytes and formatDuration format with Intl', () => {
  assert.match(formatBytes(1.4e9, 'en'), /1\.4\s*GB/);
  assert.match(formatBytes(450e6, 'en'), /450\s*MB/);
  assert.strictEqual(formatDuration(6540, 'tr'), '1 sa 49 dk');
  assert.strictEqual(formatDuration(2520, 'tr'), '42 dk');
  assert.match(formatDuration(2520, 'en'), /42/);
});
