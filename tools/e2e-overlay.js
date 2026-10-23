'use strict';
// Debug helper: open a page with the extension and report the overlay state.
const path = require('path');
const fs = require('fs');
const { Browser } = require('./cdp');
const [exe, profile, outDir, pageUrl] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = new Browser(exe, [`--user-data-dir=${profile}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--window-size=1280,900']);
  try {
    const { id } = await b.send('Extensions.loadUnpacked', { path: path.join(__dirname, '..', 'extension') });
    const { targetId } = await b.send('Target.createTarget', { url: pageUrl });
    const page = await b.attach(targetId);
    await b.send('Page.enable', {}, page);
    await sleep(6000);
    const { targetInfos } = await b.send('Target.getTargets');
    const sw = await b.attach(targetInfos.find(x => x.type === 'service_worker' && x.url.includes(id)).targetId);
    const tabs = await b.evaluate(sw, 'chrome.tabs.query({}).then(t => t.map(x => ({id: x.id, url: x.url})))');
    const tab = tabs.find(t => t.url.startsWith(pageUrl.slice(0, 25)));
    for (let i = 0; i < 8; i++) {
      const st = (await b.evaluate(sw, `chrome.storage.session.get('tab:${tab.id}')`))[`tab:${tab.id}`];
      if (st && st.sources.length) break;
      await b.evaluate(sw, `chrome.tabs.sendMessage(${tab.id}, {type:'trigger'}).catch(String)`);
      await sleep(2500);
    }
    await sleep(2000);
    console.log(await b.evaluate(page, `({children: [...document.documentElement.children].map(e => e.tagName + (e.shadowRoot ? '(open)' : '') + ' ' + (e.getAttribute('style')||'').slice(0,40)),
      frames: [...document.querySelectorAll('iframe, video')].map(e => { const r = e.getBoundingClientRect(); return e.tagName + ' ' + Math.round(r.left)+','+Math.round(r.top)+' '+Math.round(r.width)+'x'+Math.round(r.height); })})`));
    // Click the overlay button (same position formula as overlay.js), then the panel opens.
    const pos = await b.evaluate(page, `(() => {
      let best = null, area = 0;
      for (const el of document.querySelectorAll(document.querySelector('#movie_player') ? '#movie_player' : 'iframe, video')) {
        const r = el.getBoundingClientRect();
        if (r.width >= 240 && r.height >= 135 && r.width * r.height > area && r.bottom > 0 && r.top < innerHeight) { best = r; area = r.width * r.height; }
      }
      if (!best) return { x: innerWidth - 60, y: innerHeight - 35 };
      return { x: Math.min(innerWidth - 110, best.right - 100) + 40, y: Math.max(8, best.top + 10) + 12 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await b.send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, page);
    }
    await sleep(6000);
    const shot = await b.send('Page.captureScreenshot', { format: 'png' }, page);
    fs.writeFileSync(path.join(outDir, 'overlay.png'), Buffer.from(shot.data, 'base64'));
  } finally { b.close(); }
})().catch(e => { console.error(e); process.exit(1); });
