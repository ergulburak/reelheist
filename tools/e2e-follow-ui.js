'use strict';
// UI part of tools/e2e-follow.js (run with --ui): the popup's "Follow" row, the "New episodes"
// card, and the followed-series list under Settings → Download.
const assert = require('assert');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run({ b, sw, pop, extId, tabId, base, site, msg, follows }) {
  const open = async tab => {
    await b.send('Page.navigate', { url: `chrome-extension://${extId}/popup.html?tab=${tab}` }, pop);
    await sleep(3000);
  };
  const ev = expr => b.evaluate(pop, expr);
  const row = () => ev(`(() => { const r = document.getElementById('followRow'); return r && !r.hidden ? r.textContent.trim() : null; })()`);

  // A series page: the row offers "Follow"; a click follows and the row says so.
  // Reload the tab first: following takes what the page shows now as already seen.
  await b.evaluate(sw, `chrome.tabs.reload(${tabId})`);
  await sleep(3000);
  await open(tabId);
  assert.match(String(await row()), /Takip et/);
  // The page has no video, so the popup keeps polling it; the row must not be redrawn each time.
  await ev(`window.__btn = document.querySelector('#followRow button'); 1`);
  await sleep(7000);
  assert.strictEqual(await ev(`document.querySelector('#followRow button') === window.__btn`), true, 'row redrawn');
  await ev(`document.querySelector('#followRow button').click()`);
  await sleep(1500);
  assert.match(String(await row()), /Takip ediliyor/);
  assert.strictEqual((await follows()).length, 1);
  await b.evaluate(sw, `chrome.alarms.clear('follow-check')`); // the test starts the checks itself
  console.log('ok ui-1 follow row');

  // New episodes show on the card; "Remove" takes one off, "Download" queues one.
  site.episodes.push([3, 1], [3, 2]);
  assert.strictEqual((await msg({ type: 'follow-check-now' })).result, 'done');
  await b.evaluate(sw, `chrome.notifications.getAll().then(n => Promise.all(Object.keys(n).map(id => chrome.notifications.clear(id))))`);
  await open(tabId);
  const rows = () => ev(`[...document.querySelectorAll('#followCard .follow-ep')].map(r => r.dataset.ep)`);
  assert.deepStrictEqual(await rows(), ['3x1', '3x2']);
  // Long words (de, ru) and right-to-left (ar) must fit the 360 px popup.
  await b.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 600, deviceScaleFactor: 1, mobile: false }, pop);
  for (const lang of ['de', 'ru', 'ar', 'tr']) {
    await b.evaluate(sw, `chrome.storage.local.get('settings').then(r => chrome.storage.local.set({ settings: { ...r.settings, lang: '${lang}' } }))`);
    await open(tabId);
    const over = await ev(`[...document.querySelectorAll('#followCard, #followCard *, #followRow, #followRow *')]
      .filter(e => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1).map(e => e.className)`);
    assert.deepStrictEqual(over, [], `${lang} overflow`);
  }
  await b.send('Emulation.clearDeviceMetricsOverride', {}, pop);
  await ev(`document.querySelector('#followCard .follow-ep[data-ep="3x1"] .btn-follow-remove').click()`);
  await sleep(1200);
  assert.deepStrictEqual(await rows(), ['3x2']);
  assert.deepStrictEqual(Object.keys(await b.evaluate(sw, 'chrome.notifications.getAll()')), [], 'no notification from the card');
  await ev(`document.querySelector('#followCard .follow-ep[data-ep="3x2"] .btn-follow-download').click()`);
  await sleep(2500);
  assert.strictEqual(await ev(`(() => { const c = document.getElementById('followCard'); return !c || c.hidden; })()`), true, 'card empty after download');
  assert.deepStrictEqual((await follows())[0].pending, []);
  console.log('ok ui-2 card remove + download');

  // A page with no episode list has no follow row.
  const { targetId } = await b.send('Target.createTarget', { url: `${base}/nothing-here` });
  await sleep(2500);
  const tabs = await b.evaluate(sw, 'chrome.tabs.query({}).then(t => t.map(x => ({ id: x.id, url: x.url })))');
  const other = tabs.find(t => t.url.startsWith(`${base}/nothing-here`)).id;
  await open(other);
  assert.strictEqual(await row(), null);
  await b.send('Target.closeTarget', { targetId });
  console.log('ok ui-4 no row without an episode list');

  // Settings → Download lists the follow; "Unfollow" removes it.
  await ev(`document.getElementById('btnSettings').click()`);
  await sleep(400);
  await ev(`document.getElementById('setTab-download').click()`);
  await sleep(600);
  const item = await ev(`(() => { const r = document.querySelector('#followList .follow-item'); return r ? r.textContent : null; })()`);
  assert.ok(item && item.includes('Demo') && item.includes('Son kontrol'), String(item));
  // "Check now" while a season search runs says that the check waits.
  await msg({ type: 'queue-episodes', items: [{ url: `${base}/show/demo/season-1/episode-1/`, season: 1, episode: 1 }], options: { name: 'Demo' } });
  await ev(`document.querySelector('#followList .follow-item .btn-follow-check').click()`);
  await sleep(1500);
  assert.match(await ev(`document.getElementById('followList').textContent`), /sezon araması sürüyor/i);
  console.log('ok ui-3a busy check is reported');
  await ev(`document.querySelector('#followList .follow-item .btn-follow-unfollow').click()`);
  await sleep(1200);
  assert.deepStrictEqual(await follows(), []);
  assert.match(await ev(`document.getElementById('followList').textContent`), /Henüz takip edilen dizi yok/);
  console.log('ok ui-3 settings list + unfollow');
}

module.exports = { run };
