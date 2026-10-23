'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, checkUpdate } = require('../lib/update');

test('compareVersions: 0.1.0 < 0.2.0', () => {
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
  assert.equal(compareVersions('v0.1.0', 'v0.1.0'), 0);
});

test('compareVersions: 0.10.0 > 0.9.0', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('v0.9.0', '0.10.0'), -1);
});

test('compareVersions: 0.2.0-beta < 0.2.0', () => {
  assert.equal(compareVersions('0.2.0-beta', '0.2.0'), -1);
  assert.equal(compareVersions('0.2.0', '0.2.0-beta'), 1);
  assert.equal(compareVersions('0.2.0-alpha', '0.2.0-beta'), -1);
});

test('checkUpdate: network error -> available:false', async () => {
  const res = await checkUpdate({
    repo: 'ergulburak/reelheist',
    current: '0.1.0',
    fetch: async () => { throw new Error('network down'); },
  });
  assert.deepEqual(res, {
    current: '0.1.0',
    latest: null,
    url: null,
    available: false,
  });
});

test('checkUpdate: asset URL picked by name ReelHeist-Setup-0.2.0.exe', async () => {
  const fakeFetch = async url => {
    assert.equal(url, 'https://api.github.com/repos/ergulburak/reelheist/releases/latest');
    return {
      ok: true,
      json: async () => ({
        tag_name: 'v0.2.0',
        html_url: 'https://github.com/ergulburak/reelheist/releases/tag/v0.2.0',
        assets: [
          { name: 'checksums.txt', browser_download_url: 'https://example.com/checksums.txt' },
          { name: 'ReelHeist-Setup-0.2.0.exe', browser_download_url: 'https://github.com/ergulburak/reelheist/releases/download/v0.2.0/ReelHeist-Setup-0.2.0.exe' },
        ],
      }),
    };
  };

  const res = await checkUpdate({
    repo: 'ergulburak/reelheist',
    current: '0.1.0',
    fetch: fakeFetch,
  });

  assert.equal(res.current, '0.1.0');
  assert.equal(res.latest, '0.2.0');
  assert.equal(res.available, true);
  assert.equal(res.url, 'https://github.com/ergulburak/reelheist/releases/download/v0.2.0/ReelHeist-Setup-0.2.0.exe');
});
