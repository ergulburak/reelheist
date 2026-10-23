'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startGuideServer } = require('../lib/guide-server');

test('status false before hello, true after', async () => {
  const srv = await startGuideServer({ basePort: 0, browsers: ['brave', 'chrome'] });
  try {
    let res = await fetch(`${srv.url}status`);
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.extensionConnected, false);
    assert.deepEqual(body.browsers, ['brave', 'chrome']);

    srv.markConnected();

    res = await fetch(`${srv.url}status`);
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.extensionConnected, true);
  } finally {
    await srv.close();
  }
});

test('only GET / and /status (and known guide assets), others 404', async () => {
  const srv = await startGuideServer({ basePort: 0 });
  try {
    const rRoot = await fetch(srv.url);
    assert.equal(rRoot.status, 200);
    const html = await rRoot.text();
    assert.ok(html.includes('<!doctype html>'));

    const rStatus = await fetch(`${srv.url}status`);
    assert.equal(rStatus.status, 200);

    const rUnknown = await fetch(`${srv.url}unknown-route`);
    assert.equal(rUnknown.status, 404);

    const rTraversal = await fetch(`${srv.url}../package.json`);
    assert.equal(rTraversal.status, 404);

    const rPost = await fetch(`${srv.url}status`, { method: 'POST' });
    assert.equal(rPost.status, 404);
  } finally {
    await srv.close();
  }
});

test('binds 127.0.0.1 only', async () => {
  const srv = await startGuideServer({ basePort: 0 });
  try {
    const addr = srv.server.address();
    assert.equal(addr.address, '127.0.0.1');
  } finally {
    await srv.close();
  }
});

test('falls back to next port when 47861 busy and writes guide.url', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-guide-test-'));
  const urlFile = path.join(tmp, 'guide.url');
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const busyPort = blocker.address().port;

  let srv = null;
  try {
    srv = await startGuideServer({ basePort: busyPort, maxPort: busyPort + 5, urlFile });
    assert.ok(srv.port > busyPort && srv.port <= busyPort + 5, `expected fallback port > ${busyPort}, got ${srv.port}`);
    const shortcut = fs.readFileSync(urlFile, 'utf8');
    assert.ok(shortcut.includes(`URL=http://127.0.0.1:${srv.port}/`));
  } finally {
    if (srv) await srv.close();
    await new Promise(r => blocker.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
