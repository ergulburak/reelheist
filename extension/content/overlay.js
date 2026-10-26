// Top frame only: shows a download button on the player and opens the panel on click.
(() => {
  if (window !== window.top || window.__reelheistOverlay) return;
  window.__reelheistOverlay = true;

  let host = null;
  let button = null;
  let panel = null;
  let tabId = null;
  let place = () => {}; // moves the button onto the player; set when the UI is built

  // Settings → Appearance can turn the button off. The toolbar icon still opens the popup,
  // and a panel that is already open stays open.
  let enabled = true;
  const overlayOn = settings => settings?.overlay !== false;
  chrome.storage.local.get('settings')
    .then(r => { enabled = overlayOn(r.settings); place(); })
    .catch(() => {});

  function playerElement() {
    // YouTube keeps extra hidden/preview <video> elements; its main player is #movie_player.
    const yt = document.querySelector('#movie_player');
    if (yt) {
      const r = yt.getBoundingClientRect();
      if (r.width >= 240 && r.height >= 135 && r.bottom > 0 && r.top < innerHeight) return yt;
    }
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('iframe, video')) {
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.width >= 240 && r.height >= 135 && area > bestArea && r.bottom > 0 && r.top < innerHeight) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  // Content scripts cannot import modules, so the background hands over the translated
  // strings and the theme name (message 'ui-strings'); colors come from styles/tokens.css.
  let uiRequested = false;
  let closeBtn = null;
  let buttonLabel = null;
  function refreshOverlayUi() {
    chrome.runtime.sendMessage({ type: 'ui-strings', keys: ['overlayDownload', 'overlay_download', 'overlay_close'] })
      .catch(() => null)
      .then(ui => {
        if (!ui) return;
        if (!host) {
          buildUi(ui);
          return;
        }
        host.setAttribute('data-theme', ui.theme || 'red');
        host.dir = ui.dir || 'ltr';
        host.lang = ui.lang || 'en';
        if (buttonLabel) buttonLabel.textContent = ui.strings?.overlayDownload || ui.strings?.overlay_download || 'overlayDownload';
        if (closeBtn) closeBtn.setAttribute('aria-label', ui.strings?.overlay_close || 'overlay_close');
      });
  }

  function ensureUi() {
    if (host || uiRequested) return;
    uiRequested = true;
    chrome.runtime.sendMessage({ type: 'ui-strings', keys: ['overlayDownload', 'overlay_download', 'overlay_close'] })
      .catch(() => null)
      .then(ui => buildUi(ui || { strings: {}, theme: 'red', dir: 'ltr', lang: 'en' }));
  }

  function closePanel() {
    if (panel) panel.style.display = 'none';
    if (closeBtn) closeBtn.style.display = 'none';
  }

  function buildUi(ui) {
    if (host) return;
    const str = k => ui.strings?.[k] || k;
    host = document.createElement('div');
    host.setAttribute('data-theme', ui.theme || 'red');
    host.dir = ui.dir || 'ltr';
    host.lang = ui.lang || 'en';
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0;';
    const root = host.attachShadow({ mode: 'closed' });
    // No innerHTML: sites with Trusted Types (YouTube) reject it even from content scripts.
    const tokens = document.createElement('link');
    tokens.rel = 'stylesheet';
    tokens.href = chrome.runtime.getURL('styles/tokens.css');
    const style = document.createElement('style');
    style.textContent = `
      .btn { position: fixed; display: none; align-items: center; gap: 8px; height: 36px; padding: 0 15px 0 8px;
        border: 1px solid var(--line-soft); border-radius: 999px; cursor: pointer;
        background: color-mix(in srgb, var(--bg) 68%, transparent); color: var(--text);
        -webkit-backdrop-filter: blur(14px) saturate(1.4); backdrop-filter: blur(14px) saturate(1.4);
        font: 600 13px/1 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif; letter-spacing: -0.005em;
        box-shadow: 0 10px 28px -10px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.08);
        transition: transform 160ms ease, background 160ms ease, box-shadow 200ms ease;
        animation: btn-in 420ms cubic-bezier(.3,1.4,.5,1) both; }
      .btn:hover { transform: translateY(-1px); background: color-mix(in srgb, var(--bg) 86%, transparent);
        box-shadow: 0 14px 32px -10px rgba(0,0,0,.7), 0 0 0 1px var(--line), inset 0 1px 0 rgba(255,255,255,.1); }
      .btn:active { transform: scale(.97); }
      .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .dot { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; flex: none;
        background: linear-gradient(180deg, var(--accent-hi), var(--accent-lo)); color: var(--accent-text);
        box-shadow: 0 0 14px var(--glow), inset 0 1px 0 var(--sheen); transition: transform 200ms ease; }
      .btn:hover .dot { transform: translateY(1px); }
      .dot svg { width: 13px; height: 13px; }
      .panel { position: fixed; top: 16px; right: 16px; width: 360px; height: min(620px, calc(100vh - 32px));
        border: 0; border-radius: 16px; background: var(--bg); display: none; transform-origin: top right;
        box-shadow: 0 28px 64px -16px rgba(0,0,0,.7), 0 0 0 1px var(--line-soft);
        animation: panel-in 240ms cubic-bezier(.2,.8,.2,1) both; }
      .close { position: fixed; top: 6px; right: 6px; display: none; width: 28px; height: 28px; padding: 0;
        border: 1px solid var(--line-soft); border-radius: 50%; cursor: pointer; z-index: 1;
        background: color-mix(in srgb, var(--surface-2) 85%, transparent); color: var(--text);
        -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
        font: 17px/26px system-ui; box-shadow: 0 6px 16px -6px rgba(0,0,0,.6);
        transition: transform 160ms ease, background 160ms ease; animation: btn-in 300ms 80ms ease-out both; }
      .close:hover { transform: rotate(90deg); background: var(--surface-3); }
      @keyframes btn-in { from { opacity: 0; transform: translateY(-6px) scale(.9); } to { opacity: 1; transform: none; } }
      @keyframes panel-in { from { opacity: 0; transform: translateY(-8px) scale(.97); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) {
        .btn, .panel, .close, .dot { animation: none; transition: none; }
      }`;
    const el = (tag, cls, text, attrs = {}) => {
      const e = document.createElement(tag);
      e.className = cls;
      if (text) e.textContent = text;
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      return e;
    };
    button = el('button', 'btn', '', { type: 'button' });
    // Download arrow, built from DOM nodes like the popup icons (no innerHTML on Trusted Types sites).
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const arrow = document.createElementNS(NS, 'path');
    arrow.setAttribute('d', 'M12 4v11m0 0l-5-5m5 5l5-5M5 20h14');
    arrow.setAttribute('fill', 'none');
    arrow.setAttribute('stroke', 'currentColor');
    arrow.setAttribute('stroke-width', '2.6');
    arrow.setAttribute('stroke-linecap', 'round');
    arrow.setAttribute('stroke-linejoin', 'round');
    svg.append(arrow);
    const dot = el('span', 'dot');
    dot.append(svg);
    buttonLabel = el('span', 'label', ui.strings?.overlayDownload || str('overlay_download'));
    button.append(dot, buttonLabel);
    panel = el('iframe', 'panel', '', { title: 'ReelHeist' });
    closeBtn = el('button', 'close', '×', { type: 'button', 'aria-label': str('overlay_close') });
    root.append(tokens, style, button, panel, closeBtn);
    button.addEventListener('click', () => {
      // Reload every time: on YouTube the page (video) changes without a reload.
      panel.src = chrome.runtime.getURL(`popup.html?tab=${tabId}&embedded=1&t=${Date.now()}`);
      panel.style.display = 'block';
      closeBtn.style.display = 'block';
    });
    closeBtn.addEventListener('click', closePanel);
    addEventListener('message', e => {
      if (e.data && e.data.type === 'reelheist-close') closePanel();
    });
    document.documentElement.appendChild(host);
    place = () => {
      if (!enabled) {
        button.style.display = 'none';
        return;
      }
      if (/(^|\.)youtube\.com$/.test(location.hostname) && !/^\/(watch|shorts|live\/)/.test(location.pathname)) {
        button.style.display = 'none';
        return;
      }
      button.style.display = 'flex';
      const el = playerElement();
      if (!el) {
        // Player still hidden behind a poster: keep the button in the corner of the window.
        button.style.top = '';
        button.style.left = '';
        button.style.right = '20px';
        button.style.bottom = '20px';
        return;
      }
      const r = el.getBoundingClientRect();
      button.style.right = '';
      button.style.bottom = '';
      const w = button.offsetWidth || 110;
      button.style.top = `${Math.max(8, r.top + 12)}px`;
      button.style.left = `${Math.min(innerWidth - w - 10, r.right - w - 12)}px`;
    };
    place();
    addEventListener('scroll', place, { passive: true });
    addEventListener('resize', place);
    setInterval(place, 1500);
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'media' && msg.count > 0) {
      tabId = msg.tabId;
      ensureUi();
    }
  });

  chrome.storage?.onChanged?.addListener(changes => {
    if (!changes.settings) return;
    enabled = overlayOn(changes.settings.newValue);
    place();
    if (host) refreshOverlayUi();
  });

  // YouTube: no stream URLs to wait for; show the button on every YouTube page
  // (place() hides it outside video pages, the site navigates without reloads).
  if (/(^|\.)youtube\.com$/.test(location.hostname)) {
    chrome.runtime.sendMessage({ type: 'whoami' }).then(r => {
      if (r?.tabId == null) return;
      tabId = r.tabId;
      ensureUi();
    }).catch(() => {});
  }
})();
