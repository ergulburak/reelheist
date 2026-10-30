'use strict';
// "Follow a series" end to end: a local series site, the unpacked extension in a fresh profile,
// the running helper. Usage: node tools/e2e-follow.js [browser.exe] [--ui]
// Cleans up after itself: removes its test jobs and sets the helper language back.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const assert = require('assert');
const { Browser } = require('./cdp');

const EXE = process.argv.slice(2).find(a => !a.startsWith('--')) || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UI = process.argv.includes('--ui');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOCAL = process.env.LOCALAPPDATA;

// ---- the series site ----
const site = { episodes: [[1, 1], [1, 2], [1, 3]], seriesDown: false, hang: false, redirect: false };
const links = () => site.episodes.map(([s, e]) => `<li><a href="/show/demo/season-${s}/episode-${e}/">S${s} E${e}</a></li>`).join('');
const page = title => `<!doctype html><html><head><title>${title}</title><meta property="og:title" content="Demo"></head><body><h1>${title}</h1><ul>${links()}</ul></body></html>`;
const srv = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (site.hang) return; // never answers
  // A dead slug that the site sends to another series.
  if (u === '/show/demo/' && site.redirect) { res.writeHead(302, { Location: '/show/other/' }); return res.end(); }
  if (u === '/show/other/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><title>Other</title><a href="/show/other/season-5/episode-1/">x</a><a href="/show/other/season-5/episode-2/">y</a>');
  }
  if (u === '/show/demo/' && !site.seriesDown) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(page('Demo')); }
  if (/^\/show\/demo\/season-\d+\/episode-\d+\/$/.test(u)) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(page('Demo episode')); }
  res.writeHead(404); res.end('not found');
});

async function helperApi(method, p, body) {
  const info = JSON.parse(fs.readFileSync(path.join(LOCAL, 'ReelHeist', 'daemon.json'), 'utf8'));
  const r = await fetch(`http://127.0.0.1:${info.port}/api${p}`, { method, headers: { 'X-Token': info.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  return r.json();
}

async function removeDemoJobs() {
  const { jobs } = await helperApi('GET', '/jobs');
  for (const j of jobs.filter(x => String(x.group?.key || '').startsWith('Demo/'))) await helperApi('POST', `/jobs/${j.id}/remove`);
}

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const helperLang = (await helperApi('GET', '/settings')).lang;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-follow-'));
  const b = new Browser(EXE, [`--user-data-dir=${profile}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check']);
  let failed = false;
  try {
    const { id: extId } = await b.send('Extensions.loadUnpacked', { path: path.join(__dirname, '..', 'extension') });
    await sleep(1000);
    const { targetInfos } = await b.send('Target.getTargets');
    const sw = await b.attach(targetInfos.find(x => x.type === 'service_worker' && x.url.includes(extId)).targetId);
    await b.evaluate(sw, `chrome.storage.local.set({ settings: { lang: 'tr', theme: 'red', defaults: { subLangs: ['tr'] } } })`);

    const { targetId: pageT } = await b.send('Target.createTarget', { url: `${base}/show/demo/` });
    await sleep(3000);
    const tabs = await b.evaluate(sw, 'chrome.tabs.query({}).then(t => t.map(x => ({ id: x.id, url: x.url })))');
    const tabId = tabs.find(t => t.url.startsWith(`${base}/show/demo/`)).id;
    const { targetId: popT } = await b.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html?tab=${tabId}` });
    const pop = await b.attach(popT);
    await b.send('Page.enable', {}, pop);
    await sleep(2500);
    const msg = m => b.evaluate(pop, `chrome.runtime.sendMessage(${JSON.stringify({ tabId, ...m })})`);
    const follows = () => b.evaluate(sw, `chrome.storage.local.get('follows').then(r => r.follows || [])`);
    const notes = () => b.evaluate(sw, `chrome.notifications.getAll()`);

    // 1. Follow from the series page: every listed episode is seen.
    const st0 = await msg({ type: 'follow-status' });
    assert.strictEqual(st0.follow, null, 'not followed yet');
    assert.strictEqual(await b.evaluate(sw, `chrome.alarms.get('follow-check').then(a => !!a)`), false, 'no check alarm without a follow');
    const added = await msg({ type: 'follow-add', name: 'Demo' });
    assert.ok(added.follow?.id, JSON.stringify(added));
    let f = (await follows())[0];
    assert.deepStrictEqual(f.seen, ['1x1', '1x2', '1x3']);
    assert.strictEqual((await msg({ type: 'follow-status' })).follow.id, f.id);
    // follow-add sets the first check one minute later; here the test starts every check itself.
    assert.ok(await b.evaluate(sw, `chrome.alarms.get('follow-check').then(a => !!a)`), 'check alarm set');
    await b.evaluate(sw, `chrome.alarms.clear('follow-check')`);
    console.log('ok 1 follow-add: 3 episodes seen');

    // 2. A new episode and a new season: one notification, two pending episodes.
    site.episodes.push([1, 4], [2, 1]);
    assert.strictEqual(await msg({ type: 'follow-check-now' }).then(r => r.result), 'done');
    f = (await follows())[0];
    assert.deepStrictEqual(f.pending.map(p => `${p.season}x${p.episode}`), ['1x4', '2x1']);
    assert.ok(Object.keys(await notes()).includes(`follow:${f.id}`), JSON.stringify(await notes()));
    console.log('ok 2 new episode + new season found and announced');

    // 2b. The notification stays unanswered and a later check finds more: "Download" takes all of them.
    site.episodes.push([2, 9]);
    await msg({ type: 'follow-check-now' });
    const noteIds = await b.evaluate(sw, `chrome.storage.session.get('follownote:${f.id}').then(r => r['follownote:${f.id}'])`);
    assert.deepStrictEqual(noteIds, ['1x4', '2x1', '2x9']);
    console.log('ok 2b the second notification keeps the earlier episodes');

    // 3. The next check announces nothing again.
    await b.evaluate(sw, `chrome.notifications.clear('follow:${f.id}')`);
    await msg({ type: 'follow-check-now' });
    assert.deepStrictEqual(Object.keys(await notes()), []);
    assert.strictEqual((await follows())[0].pending.length, 3, 'still on the card (1x4, 2x1, 2x9)');
    console.log('ok 3 no second notification');

    // 4. A page that does not open: error kept, nothing new, nothing lost.
    site.seriesDown = true;
    site.episodes.push([2, 2]);
    await msg({ type: 'follow-check-now' });
    f = (await follows())[0];
    // The fallback opens the newest known episode page, which still lists the episodes.
    assert.ok(f.seen.includes('2x2') || f.lastError, JSON.stringify(f));
    site.seriesDown = false;
    console.log(`ok 4 series page down: ${f.lastError ? 'error kept' : 'fallback page used'}`);

    // 4b. A site that never answers: the check stops at its time limit, keeps the error, loses nothing.
    site.hang = true;
    const before = (await follows())[0];
    const t0 = Date.now();
    // The check may take its full minute: longer than one CDP call may wait, so poll for the answer.
    await b.evaluate(pop, `(window.__r = null, chrome.runtime.sendMessage({ tabId: ${tabId}, type: 'follow-check-now' }).then(r => { window.__r = r; }), 1)`);
    while (!(await b.evaluate(pop, 'window.__r')) && Date.now() - t0 < 120000) await sleep(1000);
    const took = (Date.now() - t0) / 1000;
    f = (await follows())[0];
    site.hang = false;
    assert.strictEqual((await b.evaluate(pop, 'window.__r')).result, 'done');
    assert.ok(took < 75, `took ${took} s`);
    assert.strictEqual(f.lastError, 'empty');
    assert.deepStrictEqual(f.seen, before.seen);
    assert.deepStrictEqual(f.pending, before.pending);
    console.log(`ok 4b site does not answer: stopped after ${took.toFixed(0)} s, error kept`);

    // 4c. The followed page redirects to another series: its episodes are not new for this one.
    site.redirect = true;
    await msg({ type: 'follow-check-now' });
    site.redirect = false;
    f = (await follows())[0];
    assert.ok(!f.seen.some(id => id.startsWith('5x')), JSON.stringify(f.seen));
    assert.ok(!f.pending.some(p => p.season === 5));
    console.log('ok 4c a redirect to another series adds nothing');

    // 5. Download from the notification path: the episodes go to the queue and leave the card.
    await removeDemoJobs();
    f = (await follows())[0];
    const ids = f.pending.map(p => `${p.season}x${p.episode}`);
    const dl = await msg({ type: 'follow-download', id: f.id, ids });
    assert.ok(!dl.error, JSON.stringify(dl));
    const { jobs } = await helperApi('GET', '/jobs');
    const demo = jobs.filter(j => String(j.group?.key || '').startsWith('Demo/'));
    assert.strictEqual(demo.length, ids.length, JSON.stringify(demo.map(j => j.state)));
    assert.ok(demo.every(j => j.embedSubs?.lang === 'tr'), 'options from the stored settings');
    assert.deepStrictEqual((await follows())[0].pending, []);
    console.log(`ok 5 follow-download queued ${demo.length} episodes`);

    // 5b. "Download" on a notification that fails says so in a notification.
    await msg({ type: 'follow-button', notificationId: 'follow:missing', index: 0 });
    await sleep(1000);
    assert.ok(Object.keys(await notes()).includes('follow-error:missing'), JSON.stringify(await notes()));
    await b.evaluate(sw, `chrome.notifications.clear('follow-error:missing')`);
    console.log('ok 5b a failed download from the notification is reported');

    // 6. A check while the season search runs waits and retries later.
    const busy = await msg({ type: 'follow-check-now' });
    assert.strictEqual(busy.result, 'busy', JSON.stringify(busy));
    assert.ok(await b.evaluate(sw, `chrome.alarms.get('follow-retry').then(a => !!a)`), 'retry alarm');
    console.log('ok 6 busy while the resolver runs');
    await removeDemoJobs();

    // 7. Remove from the card, unfollow. One new episode is announced in the singular.
    site.episodes.push([2, 3]);
    await b.evaluate(sw, `(() => { const o = chrome.notifications.create.bind(chrome.notifications);
      self.__notes = {}; chrome.notifications.create = (id, opts) => { self.__notes[id] = opts; return o(id, opts); }; })()`);
    // The canceled season search needs a few seconds to stop and close its window.
    let r7 = 'busy';
    for (let i = 0; i < 15 && r7 === 'busy'; i++) {
      await sleep(2000);
      r7 = (await msg({ type: 'follow-check-now' })).result;
    }
    assert.strictEqual(r7, 'done');
    f = (await follows())[0];
    const note7 = await b.evaluate(sw, `self.__notes['follow:${f.id}']`);
    assert.strictEqual(note7?.message, 'Demo: 1 yeni bölüm (S02E03). İndireyim mi?', JSON.stringify(note7));
    const last = f.pending[f.pending.length - 1];
    if (last) {
      await msg({ type: 'follow-dismiss', id: f.id, epId: `${last.season}x${last.episode}` });
      assert.ok(!(await follows())[0].pending.some(p => p.season === last.season && p.episode === last.episode));
    }
    await b.evaluate(sw, `chrome.alarms.create('follow-check', { periodInMinutes: 360 })`);
    await msg({ type: 'follow-remove', id: f.id });
    assert.deepStrictEqual(await follows(), []);
    assert.strictEqual(await b.evaluate(sw, `chrome.alarms.get('follow-check').then(a => !!a)`), false, 'check alarm cleared with the last follow');
    console.log('ok 7 dismiss and unfollow');

    // 8. A page without an episode list cannot be followed, and the error says so.
    const { targetId: noneT } = await b.send('Target.createTarget', { url: `${base}/nothing-here` });
    await sleep(2000);
    const tabs8 = await b.evaluate(sw, 'chrome.tabs.query({}).then(t => t.map(x => ({ id: x.id, url: x.url })))');
    const noneTab = tabs8.find(t => t.url.startsWith(`${base}/nothing-here`)).id;
    const r8 = await b.evaluate(pop, `chrome.runtime.sendMessage(${JSON.stringify({ tabId: noneTab, type: 'follow-add', name: 'None' })})`);
    assert.strictEqual(r8?.code, 'follow_no_list', JSON.stringify(r8));
    await b.send('Target.closeTarget', { targetId: noneT });
    console.log('ok 8 no episode list: follow_no_list');

    if (UI) await require('./e2e-follow-ui').run({ b, sw, pop, extId, tabId, base, site, msg, follows });
    console.log('e2e-follow: PASS');
  } catch (e) {
    failed = true;
    console.error('e2e-follow: FAIL', e.stack || e);
  } finally {
    await removeDemoJobs().catch(() => {});
    await helperApi('POST', '/settings', { lang: helperLang }).catch(() => {});
    b.close();
    srv.close();
    await sleep(500);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    process.exit(failed ? 1 : 0);
  }
})();
