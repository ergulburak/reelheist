import { api } from './lib/helper.js';
import { initI18n, applyI18n, t } from './lib/i18n.js';
import { applyTheme } from './lib/theme.js';
import { loadUiSettings } from './lib/ui-settings.js';
import { icon } from './ui/icons.js';
import { createPageView } from './ui/page-view.js';
import { createDownloadsView } from './ui/downloads-view.js';
import { createStatusBar } from './ui/status-bar.js';
import { createSettingsView } from './ui/settings-view.js';

let ui = await loadUiSettings();
applyTheme(ui.theme);
await initI18n(ui.lang);
applyI18n(document);

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
if (params.has('embedded')) document.body.classList.add('embedded');

const tabId = Number(params.get('tab')) ||
  (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;

const bg = msg => chrome.runtime.sendMessage({ tabId, ...msg }).then(r => {
  if (r?.error) throw Object.assign(new Error(r.error), { code: r.code });
  return r;
});

function errText(e) {
  const key = `err_${e?.code}`;
  return e?.code && t(key) !== key ? t(key) : (e?.message || String(e));
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

// Header setup
$('headerLogo')?.replaceChildren('Reel', h('b', {}, 'Heist'));
$('btnBack')?.replaceChildren(icon('back'));
$('btnSettings')?.replaceChildren(icon('gear'));

let currentView = 'page';
let settings = { outDir: '' };

function showView(name) {
  currentView = name;
  $('page').hidden = name !== 'page';
  $('queue').hidden = name !== 'queue';
  $('settings').hidden = name !== 'settings';
  const isSub = name !== 'page';
  $('btnBack').hidden = !isSub;
  $('headerLogo').hidden = isSub;
  $('headerTitle').hidden = !isSub;
  if (name === 'queue') {
    $('headerTitle').textContent = t('status_bar_downloads');
    refreshQueue();
  } else if (name === 'settings') {
    $('headerTitle').textContent = t('settings_summary');
    settingsView.open();
  }
}

$('btnBack')?.addEventListener('click', () => showView('page'));
$('btnSettings')?.addEventListener('click', () => showView(currentView === 'settings' ? 'page' : 'settings'));

const statusBar = createStatusBar({
  onClick: () => showView(currentView === 'queue' ? 'page' : 'queue'),
});
statusBar.wire();

const downloadsView = createDownloadsView({
  bg,
  errText,
  onRefresh: () => refreshQueue(),
});
downloadsView.wire();

const pageView = createPageView({
  bg,
  getUi: () => ui,
  getSettings: () => settings,
  setSettings: s => { settings = s; },
  errText,
  showView,
  onJobAdded: () => refreshQueue(),
});
pageView.wire();

const settingsView = createSettingsView({
  bg,
  getUi: () => ui,
  setUi: next => { ui = next; },
  getSettings: () => settings,
  setSettings: s => { settings = s; },
  errText,
  onUiChanged: () => {
    if (currentView === 'queue') $('headerTitle').textContent = t('status_bar_downloads');
    else if (currentView === 'settings') $('headerTitle').textContent = t('settings_summary');
    pageView.refreshI18n();
    refreshQueue();
  },
  onPacksChanged: () => {
    pageView.loadPage();
  },
  onUpdateInfo: info => {
    statusBar.setUpdateInfo(info);
    refreshQueue();
  },
});
settingsView.wire();

let queueTimer = null;
async function refreshQueue() {
  clearTimeout(queueTimer);
  try {
    const { jobs } = await api('GET', '/jobs');
    statusBar.render(jobs);
    pageView.onJobsUpdate(jobs);
    await downloadsView.render(jobs);
  } catch (e) {
    statusBar.render([]);
    if (!$('queue').hidden) downloadsView.setStatus($('seasonStatus'), errText(e), true);
  }
  queueTimer = setTimeout(refreshQueue, 1000);
}

// Keyboard shortcuts: Enter = Download on "This page"; Esc = close menu / back / close panel.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (pageView.closeMenus()) {
      e.preventDefault();
      return;
    }
    if (currentView !== 'page') {
      e.preventDefault();
      showView('page');
      return;
    }
    try { window.parent?.postMessage({ type: 'reelheist-close' }, '*'); } catch { /* ignore */ }
    window.close();
  } else if (e.key === 'Enter') {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SUMMARY') return;
    const dl = $('download');
    if (currentView === 'page' && !$('pageForm').hidden && dl && !dl.hidden && !dl.disabled) {
      e.preventDefault();
      dl.click();
    }
  }
});

// React to theme/lang changes in storage
chrome.storage?.onChanged?.addListener(async changes => {
  if (!changes.settings) return;
  ui = await loadUiSettings();
  applyTheme(ui.theme);
  await initI18n(ui.lang);
  applyI18n(document);
  if (currentView === 'queue') $('headerTitle').textContent = t('status_bar_downloads');
  else if (currentView === 'settings') $('headerTitle').textContent = t('settings_summary');
  pageView.refreshI18n();
  settingsView.refreshI18n();
  refreshQueue();
});

pageView.loadPage();
refreshQueue();
api('GET', '/update').then(info => {
  statusBar.setUpdateInfo(info);
  refreshQueue();
}).catch(() => {});
