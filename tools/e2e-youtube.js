'use strict';
// End-to-end YouTube check: popup fields, a 144p download, and a playlist listing.
// Usage: node tools/e2e-youtube.js <browser.exe> <profileDir> <outDir> <videoUrl> [playlistUrl]
const path = require('path');
const fs = require('fs');
const { Browser } = require('./cdp');

const [exe, profile, outDir, videoUrl, playlistUrl] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = new Browser(exe, [`--user-data-dir=${profile}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1280,900']);
  try {
    const { id } = await b.send('Extensions.loadUnpacked', { path: path.join(__dirname, '..', 'extension') });
    const { targetId } = await b.send('Target.createTarget', { url: videoUrl });
    await sleep(7000);
    let sw;
    for (let i = 0; i < 20 && !sw; i++) {
      const { targetInfos } = await b.send('Target.getTargets');
      const t = targetInfos.find(x => x.type === 'service_worker' && x.url.includes(id));
      if (t) sw = await b.attach(t.targetId); else await sleep(1000);
    }
    const tabs = await b.evaluate(sw, 'chrome.tabs.query({}).then(t => t.map(x => ({id: x.id, url: x.url})))');
    const tab = tabs.find(t => t.url.includes('youtube.com'));
    console.log('tab', tab);

    const { targetId: popupTarget } = await b.send('Target.createTarget', { url: `chrome-extension://${id}/popup.html?tab=${tab.id}` });
    const popup = await b.attach(popupTarget);
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await sleep(1000);
      ready = await b.evaluate(popup, "!document.getElementById('pageForm').hidden || document.getElementById('pageStatus').classList.contains('err')");
    }
    const summary = await b.evaluate(popup, `({
      status: document.getElementById('pageStatus').textContent,
      kind: document.getElementById('kind').value,
      name: document.getElementById('name').value,
      channel: document.getElementById('channel').value,
      quality: document.getElementById('quality').value,
      qualities: [...document.querySelectorAll('#quality option')].map(o => o.textContent).join(', '),
      audiosChecked: [...document.querySelectorAll('#audios input:checked')].map(i => i.parentElement.textContent),
      audiosTotal: document.querySelectorAll('#audios input').length,
      subsChecked: [...document.querySelectorAll('#subs input:checked')].map(i => i.parentElement.textContent),
      subsTotal: document.querySelectorAll('#subs input').length,
      target: document.getElementById('target').textContent,
      playlistBox: !document.getElementById('playlistBox').hidden,
    })`);
    console.log('popup', JSON.stringify(summary, null, 1));
    // Preview: the clip <video> must reach readyState >= 2 within 4 s of the popup becoming ready.
    const t0 = Date.now();
    let pv = null;
    while (Date.now() - t0 < 4000) {
      pv = await b.evaluate(popup, `(() => { const v = document.getElementById('previewVideo'); const i = document.getElementById('previewImg');
        return { readyState: v.readyState, blob: v.src.startsWith('blob:'), faded: v.classList.contains('on'), imgLoaded: i.complete && i.naturalWidth > 0, duration: v.duration }; })()`);
      if (pv.readyState >= 2) break;
      await sleep(250);
    }
    console.log('preview', JSON.stringify(pv), `after ${Date.now() - t0} ms`);
    console.log(pv && pv.readyState >= 2 ? 'PREVIEW OK (readyState >= 2 within 4 s)' : 'PREVIEW FAILED');
    await b.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 760, deviceScaleFactor: 1, mobile: false }, popup);
    fs.writeFileSync(path.join(outDir, 'yt-popup.png'), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' }, popup)).data, 'base64'));
    if (!ready || !(await b.evaluate(popup, "!document.getElementById('pageForm').hidden"))) throw new Error('popup not ready');

    // Short download: lowest quality, into outDir.
    await b.evaluate(popup, `(() => {
      const q = document.getElementById('quality');
      q.value = [...q.options].pop().value;
      const orig = window.fetch;
      window.fetch = (u, o) => {
        if (String(u).endsWith('/api/jobs') && o && o.method === 'POST') {
          const body = JSON.parse(o.body); body.outDir = ${JSON.stringify(outDir)};
          o = { ...o, body: JSON.stringify(body) };
        }
        return orig(u, o);
      };
      document.getElementById('download').click();
      return true;
    })()`);
    let last = '';
    for (let i = 0; i < 150; i++) {
      await sleep(2000);
      const text = await b.evaluate(popup, "[...document.querySelectorAll('.job')].slice(0,1).map(j => j.className + ' ' + j.textContent).join('')");
      if (text !== last) console.log('queue:', text);
      last = text;
      if (/^job (done|failed|canceled)/.test(text || '')) break;
    }
    fs.writeFileSync(path.join(outDir, 'yt-queue.png'), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' }, popup)).data, 'base64'));

    if (playlistUrl) {
      const pl = await b.evaluate(popup, `Promise.all([import('./lib/helper.js'), import('./lib/youtube.js')]).then(async ([h, y]) =>
        h.api('POST', '/probe', { kind: 'ytdlp', url: ${JSON.stringify(playlistUrl)}, playlist: true, cookies: await y.youtubeCookies() }))`);
      console.log('playlist', pl.title, pl.entries.length, pl.entries.slice(0, 3).map(e => `${e.index}. ${e.title}`));
    }

    // Overlay button on the YouTube page.
    const page = await b.attach(targetId);
    await b.send('Target.activateTarget', { targetId });
    await sleep(1500);
    fs.writeFileSync(path.join(outDir, 'yt-page.png'), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' }, page)).data, 'base64'));
  } finally {
    b.close();
  }
})().catch(e => { console.error('E2E FAILED', e); process.exit(1); });
