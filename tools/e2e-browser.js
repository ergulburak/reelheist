'use strict';
// End-to-end check in a real browser with a throwaway profile.
// Usage: node tools/e2e-browser.js <browser.exe> <profileDir> <outDir> <pageUrl> [screenshotPrefix]
// Loads the extension, opens the page, checks captured sources/subtitles, opens the popup,
// starts a short download (first 4 segments) and waits for the helper to finish it.

const path = require('path');
const fs = require('fs');
const { Browser } = require('./cdp');

const rawArgs = process.argv.slice(2);
let repoUrl = null;
const posArgs = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--repo') repoUrl = rawArgs[++i];
  else posArgs.push(rawArgs[i]);
}
const [exe, profile, outDir, pageUrl, shotPrefix = 'e2e'] = posArgs;
const extDir = path.join(__dirname, '..', 'extension');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = new Browser(exe, [
    `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    '--autoplay-policy=no-user-gesture-required',
  ]);
  try {
    const { id: extId } = await b.send('Extensions.loadUnpacked', { path: extDir });
    console.log('extension id', extId);

    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
    const page = await b.attach(targetId);
    await b.send('Page.enable', {}, page);
    await b.send('Page.navigate', { url: pageUrl }, page);
    await sleep(8000);

    const sw = async () => {
      for (let i = 0; i < 20; i++) {
        const { targetInfos } = await b.send('Target.getTargets');
        const t = targetInfos.find(x => x.type === 'service_worker' && x.url.startsWith(`chrome-extension://${extId}/`));
        if (t) return b.attach(t.targetId);
        await sleep(1000);
      }
      throw new Error('extension service worker not found');
    };
    const swSession = await sw();
    const readState = () => b.evaluate(swSession, 'chrome.storage.session.get(null)');

    let state = await readState();
    let tabKey = Object.keys(state).find(k => k.startsWith('tab:') && state[k].page?.url?.startsWith(pageUrl.slice(0, 30)));
    if (!tabKey || !state[tabKey].sources.length) {
      // Ask the extension to start the player, like the popup button does.
      const tabId = tabKey ? Number(tabKey.slice(4)) : null;
      console.log('no source yet, triggering player in tab', tabId);
      if (tabId) await b.evaluate(swSession, `chrome.tabs.sendMessage(${tabId}, {type:'trigger'}).catch(e=>String(e))`);
      for (let i = 0; i < 12; i++) {
        await sleep(2500);
        state = await readState();
        tabKey = Object.keys(state).find(k => k.startsWith('tab:') && state[k].sources?.length);
        if (tabKey) break;
        if (tabId) await b.evaluate(swSession, `chrome.tabs.sendMessage(${tabId}, {type:'trigger'}).catch(e=>String(e))`);
      }
    }
    if (!tabKey) throw new Error('no tab state with sources');
    const st = state[tabKey];
    const tabId = Number(tabKey.slice(4));
    console.log('page', st.page?.url, st.meta);
    console.log('sources', st.sources.map(s => `${s.kind} ${s.url.slice(0, 110)} ref=${s.headers.Referer}`));
    console.log('subs', st.subs.map(s => `${s.label || '?'} ${s.lang || ''} ${s.url.slice(0, 90)}`));
    console.log('devtools stub in page:', await b.evaluate(page, "typeof DisableDevtool + '/' + (window.DisableDevtool && DisableDevtool.version) + ' | ' + typeof devtoolsDetector + ' | ' + location.href"));

    // Popup in its own tab.
    const { targetId: popupTarget } = await b.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html?tab=${tabId}` });
    const popup = await b.attach(popupTarget);
    await b.send('Page.enable', {}, popup);
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      await sleep(1000);
      ready = await b.evaluate(popup, "!document.getElementById('pageForm').hidden || document.getElementById('pageStatus').classList.contains('err')");
    }

    if (repoUrl) {
      await b.evaluate(popup, `(() => {
        document.getElementById('btnSettings').click();
        const inp = document.getElementById('repoUrlInput');
        inp.value = ${JSON.stringify(repoUrl)};
        document.getElementById('addRepoBtn').click();
        return true;
      })()`);
      for (let i = 0; i < 20; i++) {
        await sleep(300);
        const trusted = await b.evaluate(popup, `(() => {
          const btn = document.querySelector('.btn-trust-repo');
          if (!btn) return false;
          btn.click();
          return true;
        })()`);
        if (trusted) break;
      }
      for (let i = 0; i < 20; i++) {
        await sleep(300);
        const installed = await b.evaluate(popup, `(() => {
          const btn = document.querySelector('.btn-install-pack');
          if (!btn) return false;
          btn.click();
          return true;
        })()`);
        if (installed) break;
      }
      for (let i = 0; i < 20; i++) {
        await sleep(300);
        const hasUninstall = await b.evaluate(popup, "Boolean(document.querySelector('.btn-uninstall-pack'))");
        if (hasUninstall) break;
      }
      await b.evaluate(popup, "document.getElementById('btnBack').click()");
      await sleep(1500);
    }

    const summary = await b.evaluate(popup, `({
      status: document.getElementById('pageStatus').textContent,
      name: document.getElementById('name').value,
      kind: document.getElementById('kind').value,
      season: document.getElementById('season').value,
      episode: document.getElementById('episode').value,
      sources: [...document.querySelectorAll('#source option')].map(o => o.textContent),
      qualities: [...document.querySelectorAll('#quality option')].map(o => o.textContent),
      audios: [...document.querySelectorAll('#audios label, #audios div')].map(o => o.textContent),
      subs: [...document.querySelectorAll('#subs label, #subs div')].map(o => o.textContent),
      target: document.getElementById('target').textContent,
    })`);
    console.log('popup', JSON.stringify(summary, null, 1));
    await b.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 640, deviceScaleFactor: 1, mobile: false }, popup);
    const shot = await b.send('Page.captureScreenshot', { format: 'png' }, popup);
    fs.writeFileSync(path.join(outDir, `${shotPrefix}-popup.png`), Buffer.from(shot.data, 'base64'));

    // Start a short download: patch fetch so the job only takes the first 4 segments.
    if (!ready || !(await b.evaluate(popup, "!document.getElementById('pageForm').hidden"))) throw new Error('popup not ready');
    await b.evaluate(popup, `(() => {
      const orig = window.fetch;
      window.fetch = (u, o) => {
        if (String(u).endsWith('/api/jobs') && o && o.method === 'POST') {
          const body = JSON.parse(o.body); body.maxSegments = 4; body.outDir = ${JSON.stringify(outDir)};
          o = { ...o, body: JSON.stringify(body) };
        }
        return orig(u, o);
      };
      document.getElementById('download').click();
      return true;
    })()`);
    let job = null;
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      const text = await b.evaluate(popup, "[...document.querySelectorAll('.job')].slice(0,1).map(j => j.className + ' ' + j.textContent).join('')");
      if (text !== job) console.log('queue:', text);
      job = text;
      if (/^job (done|failed|canceled)/.test(text || '')) break;
    }
    const shot2 = await b.send('Page.captureScreenshot', { format: 'png' }, popup);
    fs.writeFileSync(path.join(outDir, `${shotPrefix}-queue.png`), Buffer.from(shot2.data, 'base64'));

    // Overlay button in the page.
    await b.send('Target.activateTarget', { targetId }, undefined);
    await sleep(1500);
    const shot3 = await b.send('Page.captureScreenshot', { format: 'png' }, page);
    fs.writeFileSync(path.join(outDir, `${shotPrefix}-page.png`), Buffer.from(shot3.data, 'base64'));

    if (process.env.E2E_SEASON) {
      const eps = await b.evaluate(popup, `chrome.runtime.sendMessage({type:'episodes', tabId:${tabId}})`);
      console.log('episodes found', eps.episodes.length, eps.episodes.slice(0, 3));
      const next = eps.episodes.find(e => e.season === st.meta.season && e.episode === st.meta.episode + 1)
        || eps.episodes.find(e => e.url !== st.page.url);
      console.log('season test resolving', next.url);
      await b.evaluate(popup, `chrome.runtime.sendMessage({type:'queue-episodes', tabId:${tabId}, items:[${JSON.stringify(next)}], options:{name:'E2E Sezon', outDir:${JSON.stringify(outDir)}}})`);
      for (let i = 0; i < 60; i++) {
        await sleep(2000);
        const s = await b.evaluate(popup, "chrome.runtime.sendMessage({type:'season-status'})");
        if (!s.running) { console.log('season status', JSON.stringify(s)); break; }
      }
      const jobs = await b.evaluate(popup, `import('./lib/helper.js').then(m => m.api('GET','/jobs'))`);
      const sj = jobs.jobs.find(j => j.names.folder === 'E2E Sezon');
      console.log('season job', sj && { base: sj.names.base, state: sj.state, source: sj.source.url.slice(0, 100), subs: (sj.subtitles || []).length });
      if (sj) await b.evaluate(popup, `import('./lib/helper.js').then(m => m.api('POST','/jobs/${sj?.id}/remove'))`);
    }
  } finally {
    b.close();
  }
})().catch(e => {
  console.error('E2E FAILED', e);
  process.exit(1);
});
