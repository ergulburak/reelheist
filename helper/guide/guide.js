'use strict';
(() => {
  const LOCALES = [
    ['tr', 'Türkçe'],
    ['en', 'English'],
    ['es', 'Español'],
    ['pt_BR', 'Português (Brasil)'],
    ['fr', 'Français'],
    ['de', 'Deutsch'],
    ['ru', 'Русский'],
    ['ar', 'العربية'],
    ['zh_CN', '中文（简体）'],
    ['id', 'Bahasa Indonesia'],
    ['ja', '日本語'],
    ['hi', 'हिन्दी'],
  ];

  const BROWSER_URLS = {
    brave: 'brave://extensions',
    chrome: 'chrome://extensions',
    edge: 'edge://extensions',
  };

  const $ = id => document.getElementById(id);
  const boot = window.__GUIDE_BOOTSTRAP__ || {};
  let messages = {};
  let connected = false;
  let activeBrowser = 'brave';

  function resolveLang(raw) {
    const s = String(raw || '').replace('-', '_');
    if (LOCALES.some(([c]) => c === s)) return s;
    const lower = s.toLowerCase();
    if (lower.startsWith('pt')) return 'pt_BR';
    if (lower.startsWith('zh')) return 'zh_CN';
    const base = lower.split('_')[0];
    return LOCALES.some(([c]) => c === base) ? base : 'en';
  }

  function detectBrowser() {
    const ua = navigator.userAgent || '';
    if (/Edg\//.test(ua)) return 'edge';
    if (navigator.brave || /Brave/i.test(ua)) return 'brave';
    if (/Chrome\//.test(ua) && Array.isArray(boot.browsers) && !boot.browsers.includes('brave') && boot.browsers.includes('chrome')) {
      return 'chrome';
    }
    return (boot.browsers && boot.browsers[0]) || 'brave';
  }

  function setBrowser(b) {
    activeBrowser = BROWSER_URLS[b] ? b : 'brave';
    $('extUrlCode').textContent = BROWSER_URLS[activeBrowser];
    for (const btn of document.querySelectorAll('#browserTabs .tab')) {
      btn.classList.toggle('active', btn.dataset.browser === activeBrowser);
    }
  }

  function applyMessages() {
    const t = k => messages[k] || k;
    $('titleText').textContent = t('title');
    $('subtitleText').textContent = t('subtitle');
    $('statusText').textContent = connected ? t('status_connected') : t('status_waiting');
    $('step1Title').textContent = t('step1_title');
    $('step1Desc').textContent = t('step1_desc');
    $('step2Title').textContent = t('step2_title');
    $('step2Desc').textContent = t('step2_desc');
    $('step3Title').textContent = t('step3_title');
    $('step3Desc').textContent = t('step3_desc');
    $('copyUrlBtn').textContent = t('btn_copy');
    $('copyPathBtn').textContent = t('btn_copy');
    $('reloadTitle').textContent = t('reload_title');
    $('reloadDesc').textContent = t('reload_desc');
    $('devmodeTitle').textContent = t('note_devmode_title');
    $('devmodeDesc').textContent = t('note_devmode_desc');
    $('smartscreenTitle').textContent = t('note_smartscreen_title');
    $('smartscreenDesc').textContent = t('note_smartscreen_desc');
  }

  async function loadLang(code) {
    const lang = resolveLang(code);
    try {
      const res = await fetch(`/i18n/${lang}.json`);
      if (res.ok) messages = await res.json();
    } catch { /* keep current */ }
    document.documentElement.lang = lang.replace('_', '-');
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    $('langSelect').value = lang;
    applyMessages();
  }

  function wireCopy(btnId, codeId) {
    $(btnId)?.addEventListener('click', async () => {
      const text = $(codeId)?.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      const btn = $(btnId);
      btn.textContent = messages.btn_copied || 'Copied ✓';
      setTimeout(() => { btn.textContent = messages.btn_copy || 'Copy'; }, 1800);
    });
  }

  async function pollStatus() {
    try {
      const res = await fetch('/status', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.extDir && !$('extPathCode').textContent) {
          $('extPathCode').textContent = data.extDir;
        }
        if (Boolean(data.extensionConnected) !== connected) {
          connected = Boolean(data.extensionConnected);
          $('statusBanner').classList.toggle('connected', connected);
          $('statusText').textContent = connected
            ? (messages.status_connected || 'Ready ✓')
            : (messages.status_waiting || 'Waiting…');
        }
      }
    } catch { /* ignore */ }
  }

  const sel = $('langSelect');
  for (const [code, label] of LOCALES) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => loadLang(sel.value));

  for (const btn of document.querySelectorAll('#browserTabs .tab')) {
    btn.addEventListener('click', () => setBrowser(btn.dataset.browser));
  }

  if (boot.extDir) $('extPathCode').textContent = boot.extDir;
  setBrowser(detectBrowser());
  wireCopy('copyUrlBtn', 'extUrlCode');
  wireCopy('copyPathBtn', 'extPathCode');

  const params = new URLSearchParams(location.search);
  loadLang(params.get('lang') || navigator.language || 'en');
  pollStatus();
  setInterval(pollStatus, 2000);
})();
