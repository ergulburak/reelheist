// Runs in every frame. Finds subtitle tracks written into the page (player configs,
// <track> elements), reports page info from the top frame, and can start players.
(() => {
  if (window.__diziIndiriciScan) return;
  window.__diziIndiriciScan = true;
  const isTop = window === window.top;

  function decodeJsString(s) {
    try { return JSON.parse(`"${s.replace(/"/g, '\\"')}"`); } catch { return s.replace(/\\\//g, '/'); }
  }

  function abs(u) {
    try { return new URL(u, location.href).href; } catch { return null; }
  }

  const SUB_EXT = /\.(vtt|srt|ass|ssa)(\?|#|$)/i;

  function scanText(text, out) {
    // Objects such as {"file":"...vtt","label":"Türkçe","lang":"tr"} (JW Player, Playerjs, Plyr…).
    const objRe = /\{[^{}]{0,800}?\.(?:vtt|srt)[^{}]{0,800}?\}/gi;
    let m;
    while ((m = objRe.exec(text))) {
      const obj = m[0];
      const file = /["']?(?:file|src|url)["']?\s*:\s*["']([^"']+)["']/i.exec(obj);
      if (!file) continue;
      const url = abs(decodeJsString(file[1]));
      if (!url || !SUB_EXT.test(url)) continue;
      const label = /["']?(?:label|name|title)["']?\s*:\s*["']([^"']*)["']/i.exec(obj);
      const lang = /["']?(?:lang|language|srclang)["']?\s*:\s*["']([^"']*)["']/i.exec(obj);
      out.set(url, { url, label: label ? decodeJsString(label[1]) : '', lang: lang ? decodeJsString(lang[1]) : '' });
    }
    // Playerjs "subtitle" strings: "[Türkçe]https://…/tr.vtt,[English]https://…/en.vtt"
    const pjRe = /\[([^\]\[]{1,40})\](https?:[^,"'\s\]]+?\.(?:vtt|srt)[^,"'\s\]]*)/gi;
    while ((m = pjRe.exec(text))) {
      const url = abs(decodeJsString(m[2]));
      if (url && !out.has(url)) out.set(url, { url, label: decodeJsString(m[1]), lang: '' });
    }
  }

  function scan() {
    const found = new Map();
    for (const t of document.querySelectorAll('track[src]')) {
      const url = abs(t.getAttribute('src'));
      if (url) found.set(url, { url, label: t.label || '', lang: t.srclang || '' });
    }
    for (const s of document.scripts) {
      if (!s.src && s.textContent && s.textContent.length < 3e6) scanText(s.textContent, found);
    }
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    if (html.length < 5e6) scanText(html, found);
    return [...found.values()];
  }

  let lastSent = '';
  function report() {
    const items = scan();
    const key = items.map(i => i.url).sort().join('|');
    if (items.length && key !== lastSent) {
      lastSent = key;
      chrome.runtime.sendMessage({ type: 'subs', items, frameUrl: location.href }).catch(() => {});
    }
  }

  function pageInfo() {
    const og = document.querySelector('meta[property="og:title"]');
    const h1 = document.querySelector('h1');
    const img = document.querySelector('meta[property="og:image"]');
    return {
      url: location.href,
      title: document.title,
      ogTitle: og ? og.content : '',
      ogImage: img && img.content ? img.content.trim() : '',
      h1: h1 ? h1.textContent.trim().slice(0, 200) : '',
    };
  }

  // Start players that load lazily (data-src iframes, click-to-play overlays).
  const DEFAULT_LAZY = ['data-src', 'data-lazy-src'];
  const DEFAULT_PLAY = '[class*="play" i]:not(a), [id*="play" i]:not(a), .jw-display-icon-container, .vjs-big-play-button, button[aria-label*="play" i]';
  // player: optional site pack settings {lazySrcAttrs, playSelectors}.
  // force: the page is a throwaway season tab, so also click play overlays in the top frame
  // before any <video> exists (posters that load the player on click), with the pack's
  // selectors and the generic ones.
  // Players that load or play only on screen: bring the element to the middle of the view
  // (the resolver window is small, the player is often below the fold).
  function show(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch { /* detached */ }
  }

  function largest(list) {
    let best = null;
    let area = 0;
    for (const el of list) {
      const r = el.getBoundingClientRect();
      if (r.width * r.height > area) { area = r.width * r.height; best = el; }
    }
    return best;
  }

  function trigger(player, force = false) {
    const lazyAttrs = Array.isArray(player?.lazySrcAttrs) && player.lazySrcAttrs.length ? player.lazySrcAttrs : DEFAULT_LAZY;
    const packSel = Array.isArray(player?.playSelectors) && player.playSelectors.length ? player.playSelectors.join(', ') : '';
    const playSels = force && packSel ? [packSel, DEFAULT_PLAY] : [packSel || DEFAULT_PLAY];
    let acted = 0;
    // The player: a <video> in this frame, otherwise the biggest <iframe>.
    const playerEl = largest(document.querySelectorAll('video')) || largest(document.querySelectorAll('iframe'));
    if (playerEl) show(playerEl);
    for (const f of document.querySelectorAll('iframe')) {
      const ds = lazyAttrs.map(a => f.getAttribute(a)).find(Boolean);
      const src = f.getAttribute('src');
      if (ds && (!src || src === 'about:blank' || src.startsWith('data:'))) {
        f.setAttribute('src', ds);
        acted++;
      }
    }
    for (const v of document.querySelectorAll('video')) {
      v.muted = true;
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
      acted++;
    }
    // In the top frame, generic selectors only run next to a <video> (they would click random
    // "play" things on a normal page); pack selectors are written for this site, so they always run.
    if (!isTop || document.querySelector('video') || packSel || force) {
      // Up to 5 visible targets, pack selectors first.
      const targets = new Set();
      for (const sel of playSels) {
        let found = [];
        try { found = document.querySelectorAll(sel); } catch { /* bad pack selector */ }
        for (const el of found) {
          const r = el.getBoundingClientRect();
          if (targets.size < 5 && r.width > 10 && r.height > 10) targets.add(el);
        }
      }
      for (const el of targets) {
        show(el);
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        acted++;
      }
    }
    return acted;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'trigger') {
      sendResponse({ acted: trigger(msg.player, Boolean(msg.force)) });
    } else if (msg.type === 'rescan') {
      lastSent = '';
      report();
      sendResponse({ ok: true });
    } else if (msg.type === 'page-info' && isTop) {
      sendResponse(pageInfo());
    } else if (msg.type === 'set-title' && isTop) {
      // Resolver tab: the window title tells the user to leave the window open.
      document.title = String(msg.title || '');
      sendResponse({ ok: true });
    } else if (msg.type === 'links' && isTop) {
      sendResponse([...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: a.textContent })));
    }
  });

  if (isTop) chrome.runtime.sendMessage({ type: 'page', info: pageInfo() }).catch(() => {});
  report();
  // Players often write their config later; watch for a while.
  let timer = null;
  const obs = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(report, 700);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => obs.disconnect(), 30000);
})();
