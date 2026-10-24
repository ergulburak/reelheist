'use strict';
// Visual + overflow check across languages and themes.
// Usage: node tools/e2e-shots.js <browser> <profile> <out> <pageUrl> [--langs tr,de,ru,ar] [--themes red,black-beige,beige-black]

const path = require('path');
const fs = require('fs');
const { Browser } = require('./cdp');

const argv = process.argv.slice(2);
const positional = [];
let langs = ['tr', 'de', 'ru', 'ar'];
let themes = ['red', 'black-beige', 'beige-black', 'midnight', 'emerald', 'amethyst', 'amber', 'snow', 'rose', 'velvet', 'neon', 'sunset', 'arctic', 'graphite', 'lavender'];

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--langs' && argv[i + 1]) {
    langs = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
  } else if (argv[i].startsWith('--langs=')) {
    langs = argv[i].slice('--langs='.length).split(',').map(s => s.trim()).filter(Boolean);
  } else if (argv[i] === '--themes' && argv[i + 1]) {
    themes = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
  } else if (argv[i].startsWith('--themes=')) {
    themes = argv[i].slice('--themes='.length).split(',').map(s => s.trim()).filter(Boolean);
  } else {
    positional.push(argv[i]);
  }
}

const [exe, profile, outDir, pageUrl] = positional;
if (!exe || !profile || !outDir || !pageUrl) {
  console.error('Usage: node tools/e2e-shots.js <browser> <profile> <out> <pageUrl> [--langs ...] [--themes ...]');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
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
    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
    const page = await b.attach(targetId);
    await b.send('Page.enable', {}, page);
    await b.send('Page.navigate', { url: pageUrl }, page);
    await sleep(4000);

    let swSession = null;
    for (let i = 0; i < 20 && !swSession; i++) {
      const { targetInfos } = await b.send('Target.getTargets');
      const t = targetInfos.find(x => x.type === 'service_worker' && x.url.startsWith(`chrome-extension://${extId}/`));
      if (t) swSession = await b.attach(t.targetId);
      else await sleep(500);
    }
    if (!swSession) throw new Error('extension service worker not found');

    const readState = () => b.evaluate(swSession, 'chrome.storage.session.get(null)');
    let state = await readState();
    let tabKey = Object.keys(state).find(k => k.startsWith('tab:') && state[k].sources?.length);
    if (!tabKey) {
      const anyTabKey = Object.keys(state).find(k => k.startsWith('tab:'));
      const tid = anyTabKey ? Number(anyTabKey.slice(4)) : null;
      if (tid) await b.evaluate(swSession, `chrome.tabs.sendMessage(${tid}, {type:'trigger'}).catch(()=>null)`);
      for (let i = 0; i < 15 && !tabKey; i++) {
        await sleep(1000);
        state = await readState();
        tabKey = Object.keys(state).find(k => k.startsWith('tab:') && state[k].sources?.length);
      }
    }
    const tabs = await b.evaluate(swSession, 'chrome.tabs.query({})');
    const tabId = tabKey
      ? Number(tabKey.slice(4))
      : (tabs.find(t => t.url && t.url.startsWith(pageUrl.slice(0, 20)))?.id || tabs[0]?.id);

    const { targetId: popupTarget } = await b.send('Target.createTarget', {
      url: `chrome-extension://${extId}/popup.html?tab=${tabId}`,
    });
    const popup = await b.attach(popupTarget);
    await b.send('Page.enable', {}, popup);
    await b.send('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 540,
      deviceScaleFactor: 1,
      mobile: false,
    }, popup);

    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const ready = await b.evaluate(
        popup,
        "Boolean((document.getElementById('pageForm') && !document.getElementById('pageForm').hidden) || (document.getElementById('pageStatus') && document.getElementById('pageStatus').classList.contains('err')))",
      );
      if (ready) break;
    }

    const allOverflows = [];

    for (const lang of langs) {
      for (const theme of themes) {
        await b.evaluate(popup, `(async () => {
          const { saveUiSettings } = await import('./lib/ui-settings.js');
          await saveUiSettings({ lang: ${JSON.stringify(lang)}, theme: ${JSON.stringify(theme)}, motion: 'off' });
        })()`);
        await sleep(350);

        const check = await b.evaluate(popup, `(() => {
          const dir = document.documentElement.dir;
          const th = document.documentElement.dataset.theme;
          const overflows = [];
          for (const el of document.querySelectorAll('*')) {
            if (el.hidden || el.closest('[hidden]')) continue;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
              const id = el.id ? '#' + el.id : '';
              const cls = typeof el.className === 'string' && el.className.trim()
                ? '.' + el.className.trim().split(/\\s+/).join('.')
                : '';
              overflows.push({
                selector: el.tagName.toLowerCase() + id + cls,
                scrollWidth: el.scrollWidth,
                clientWidth: el.clientWidth,
                text: (el.textContent || '').trim().slice(0, 50),
              });
            }
          }
          return { dir, theme: th, overflows };
        })()`);

        const shot = await b.send('Page.captureScreenshot', { format: 'png' }, popup);
        const file = path.join(outDir, `popup-${lang}-${theme}.png`);
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        console.log(`${lang} × ${theme}: dir=${check.dir} overflows=${check.overflows.length} -> ${path.basename(file)}`);

        if (lang === 'ar' && check.dir !== 'rtl') {
          allOverflows.push(`${lang} × ${theme}: expected dir="rtl", got "${check.dir}"`);
        }
        for (const o of check.overflows) {
          allOverflows.push(`${lang} × ${theme}: ${o.selector} (${o.scrollWidth} > ${o.clientWidth}) "${o.text}"`);
        }
      }
    }

    if (allOverflows.length) {
      console.error('Overflow / layout errors:');
      for (const line of allOverflows) console.error('  ' + line);
      process.exitCode = 1;
    } else {
      console.log(`e2e-shots: OK (${langs.length * themes.length} screenshots, 0 overflows)`);
    }
  } finally {
    b.close();
  }
})().catch(e => {
  console.error('e2e-shots FAILED', e);
  process.exit(1);
});
