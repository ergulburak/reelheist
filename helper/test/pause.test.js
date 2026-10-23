'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-pause-'));
process.env.REELHEIST_DATA = DATA;

const P = require('../lib/paths');
const muxMod = require('../lib/mux');
// Stub mux so pause/resume tests do not depend on ffmpeg encoding artificial TS bytes.
muxMod.mux = async (streams, outFile) => {
  await fs.promises.writeFile(outFile, Buffer.alloc(2048, 0xaa));
};

const { Queue } = require('../lib/jobs');
const { startHlsServer } = require('./fixtures/hls-server');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('pause keeps segments and resumes without refetching them', async () => {
  const srv = await startHlsServer({ segments: 8, delayMs: 280 });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-pause-out-'));
  try {
    const q = new Queue();
    await q.load();
    await q.setSettings({ outDir });
    const job = await q.add({
      meta: { kind: 'movie', name: 'PauseTest' },
      source: { kind: 'hls', url: srv.mediaUrl },
    });

    const segDir = path.join(P.WORK_DIR, job.id, 's0');
    for (let i = 0; i < 40; i++) {
      await sleep(80);
      if (fs.existsSync(segDir)) {
        const files = fs.readdirSync(segDir).filter(f => f.endsWith('.seg'));
        if (files.length >= 2) break;
      }
    }

    const paused = await q.pause(job.id);
    assert.strictEqual(paused.state, 'paused');
    await sleep(100);
    assert.strictEqual(q.running, null);
    assert.strictEqual(q.get(job.id).state, 'paused');

    const savedBefore = fs.readdirSync(segDir).filter(f => f.endsWith('.seg'));
    assert.ok(savedBefore.length >= 2, `expected >= 2 saved segments, got ${savedBefore.length}`);

    // Snapshot request counts after pause has settled.
    const countsAtPause = new Map(srv.counts);

    await q.retry(job.id);
    for (let i = 0; i < 60 && q.get(job.id).state !== 'done'; i++) {
      await sleep(100);
      if (q.get(job.id).state === 'failed') {
        assert.fail(`job failed: ${q.get(job.id).error}`);
      }
    }
    assert.strictEqual(q.get(job.id).state, 'done');

    // Every segment that was already on disk before pause must NOT have been requested again.
    for (const segFile of savedBefore) {
      const idx = Number(segFile.replace('.seg', ''));
      const segUrl = `/seg${idx}.ts`;
      assert.strictEqual(
        srv.counts.get(segUrl),
        countsAtPause.get(segUrl),
        `segment ${segUrl} was refetched after resume`,
      );
    }
  } finally {
    await srv.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('cancel deletes work dir', async () => {
  const srv = await startHlsServer({ segments: 6, delayMs: 300 });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cancel-out-'));
  try {
    const q = new Queue();
    await q.load();
    await q.setSettings({ outDir });
    const job = await q.add({
      meta: { kind: 'movie', name: 'CancelTest' },
      source: { kind: 'hls', url: srv.mediaUrl },
    });

    const workDir = path.join(P.WORK_DIR, job.id);
    for (let i = 0; i < 30; i++) {
      await sleep(80);
      if (fs.existsSync(path.join(workDir, 's0', '000000.seg'))) break;
    }
    assert.ok(fs.existsSync(workDir), 'work dir should exist while downloading');

    await q.cancel(job.id);
    await sleep(100);
    assert.strictEqual(q.get(job.id).state, 'canceled');
    assert.strictEqual(fs.existsSync(workDir), false, 'cancel must delete work/<id>');
  } finally {
    await srv.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('paused job is not picked by kick()', async () => {
  const q = new Queue();
  await q.load();
  const job = {
    id: 'paused1',
    createdAt: Date.now(),
    state: 'paused',
    meta: { kind: 'movie', name: 'PausedOnly' },
    source: { kind: 'hls', url: 'http://127.0.0.1:9/video.m3u8', headers: {} },
    names: { folder: 'PausedOnly', base: 'PausedOnly' },
  };
  q.jobs = [job];
  q.kick();
  assert.strictEqual(q.running, null);
  assert.strictEqual(q.get('paused1').state, 'paused');
});
