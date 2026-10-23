// Captures stream and subtitle URLs per tab, runs season resolving, talks to the helper.
import { parsePage, collectEpisodes } from './lib/titles.js';
import { api } from './lib/helper.js';
import { analyzeSources } from './lib/sources.js';
import { youtubeTarget } from './lib/youtube.js';
import { initI18n, t, isRtl, currentLang, langTag } from './lib/i18n.js';
import { loadUiSettings } from './lib/ui-settings.js';
import { createStore } from './lib/packs/store.js';
import { syncDynamicRules as syncRules } from './lib/packs/dnr.js';

const packs = createStore({ storage: chrome.storage.local, fetch: globalThis.fetch.bind(globalThis) });

const syncDynamicRules = () => syncRules(() => packs.installedPacks()).catch(() => {});
syncDynamicRules();

const packFor = url => packs.packForUrl(url || '').catch(() => null);

const tabs = new Map(); // tabId → {page, meta, sources[], subs[]}
const reqHeaders = new Map(); // requestId → replayable headers
const resolverTabs = new Set();
const saveTimers = new Map();

// ---------- tab state ----------

function emptyState() {
  return { page: null, meta: null, sources: [], subs: [] };
}

async function getState(tabId) {
  if (tabs.has(tabId)) return tabs.get(tabId);
  const key = `tab:${tabId}`;
  const stored = (await chrome.storage.session.get(key))[key];
  const st = stored || emptyState();
  if (!tabs.has(tabId)) tabs.set(tabId, st);
  return tabs.get(tabId);
}

function saveState(tabId) {
  clearTimeout(saveTimers.get(tabId));
  saveTimers.set(tabId, setTimeout(() => {
    const st = tabs.get(tabId);
    if (st) chrome.storage.session.set({ [`tab:${tabId}`]: st }).catch(() => {});
  }, 300));
}

function resetState(tabId) {
  tabs.set(tabId, emptyState());
  chrome.storage.session.remove(`tab:${tabId}`).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

function notify(tabId, st) {
  const n = st.sources.length;
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b82f6' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  if (n && !resolverTabs.has(tabId)) {
    chrome.tabs.sendMessage(tabId, { type: 'media', count: n, tabId }, { frameId: 0 }).catch(() => {});
  }
}

function originOf(u) {
  try { return new URL(u).origin; } catch { return ''; }
}

// ---------- network capture ----------

const FILTER = { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] };

chrome.webRequest.onBeforeRequest.addListener(d => {
  if (d.tabId >= 0 && d.type === 'main_frame') resetState(d.tabId);
}, { urls: ['<all_urls>'], types: ['main_frame'] });

chrome.webRequest.onBeforeSendHeaders.addListener(d => {
  if (d.tabId < 0) return;
  const h = {};
  for (const { name, value } of d.requestHeaders || []) {
    const n = name.toLowerCase();
    if (n === 'referer') h.Referer = value;
    else if (n === 'origin') h.Origin = value;
    else if (n === 'user-agent') h['User-Agent'] = value;
    else if (n === 'cookie') h.Cookie = value;
  }
  reqHeaders.set(d.requestId, h);
  if (reqHeaders.size > 2000) reqHeaders.delete(reqHeaders.keys().next().value);
}, FILTER, ['requestHeaders', 'extraHeaders']);

function header(list, name) {
  const h = (list || []).find(x => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

function classify(d) {
  if (d.statusCode < 200 || d.statusCode >= 300) return null;
  const ct = header(d.responseHeaders, 'content-type').toLowerCase();
  let path = '';
  try { path = new URL(d.url).pathname.toLowerCase(); } catch { return null; }
  if (ct.includes('mpegurl') || path.endsWith('.m3u8')) return 'hls';
  if (ct.startsWith('text/vtt') || /\.(vtt|srt)$/.test(path)) return 'sub';
  if (d.type === 'media' && (/^video\/(mp4|webm|x-matroska)/.test(ct) || /\.(mp4|webm|mkv)$/.test(path))) {
    const range = header(d.responseHeaders, 'content-range');
    const total = Number((/\/(\d+)$/.exec(range) || [])[1] || header(d.responseHeaders, 'content-length') || 0);
    if (total > 5e6) return 'file';
  }
  return null;
}

chrome.webRequest.onHeadersReceived.addListener(d => {
  if (d.tabId < 0) return;
  const kind = classify(d);
  if (!kind) return;
  const headers = reqHeaders.get(d.requestId) || {};
  if (!headers.Referer && d.initiator) headers.Referer = d.initiator + '/';
  getState(d.tabId).then(st => {
    if (kind === 'sub') {
      if (!st.subs.some(s => s.url === d.url)) st.subs.push({ url: d.url, label: '', lang: '', headers, from: 'net' });
    } else if (!st.sources.some(s => s.url === d.url)) {
      st.sources.push({ url: d.url, kind, headers, time: Date.now() });
      notify(d.tabId, st);
    }
    saveState(d.tabId);
  });
}, FILTER, ['responseHeaders']);

const forget = d => reqHeaders.delete(d.requestId);
chrome.webRequest.onCompleted.addListener(forget, FILTER);
chrome.webRequest.onErrorOccurred.addListener(forget, FILTER);

chrome.tabs.onRemoved.addListener(tabId => {
  tabs.delete(tabId);
  chrome.storage.session.remove(`tab:${tabId}`).catch(() => {});
});

// YouTube navigates without page loads; mark video pages as soon as the URL changes.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.url && info.status !== 'complete') return;
  const yt = youtubeTarget(tab.url || '');
  if (!yt) {
    if (info.url && /youtube\.com/.test(info.url)) chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    return;
  }
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#ef4444' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: 'YT' }).catch(() => {});
  if (yt.videoUrl) chrome.tabs.sendMessage(tabId, { type: 'media', count: 1, tabId }, { frameId: 0 }).catch(() => {});
});

// ---------- playlists through the player frame ----------
// Some hosts (Cloudflare) answer playlist requests only from the player frame itself.
// We read them there and hand the texts to the helper; segments it fetches directly.

async function frameFetchText(tabId, url, frameOrigin) {
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: async (u, origin) => {
        if (origin ? location.origin !== origin : window !== window.top) return null;
        try {
          const r = await fetch(u);
          if (!r.ok) return { status: r.status };
          return { status: r.status, text: await r.text(), url: r.url };
        } catch (e) {
          return { error: String(e) };
        }
      },
      args: [url, frameOrigin || ''],
    });
  } catch { return null; }
  return results.map(r => r.result).find(r => r && typeof r.text === 'string') || null;
}

function playlistUrls(text, base) {
  const urls = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    try {
      if (t.startsWith('#EXT-X-MEDIA')) {
        const m = /URI="([^"]+)"/.exec(t);
        if (m) urls.add(new URL(m[1], base).href);
      } else if (!t.startsWith('#')) {
        urls.add(new URL(t, base).href);
      }
    } catch { /* bad line */ }
  }
  return [...urls];
}

async function prefetchPlaylists(tabId, source, pageUrl = '') {
  const map = {};
  if (source.kind !== 'hls') return map;
  if ((await packFor(pageUrl))?.player?.frameFetch === false) return map;
  const origin = originOf(source.headers?.Referer || '');
  const master = await frameFetchText(tabId, source.url, origin);
  if (!master || !master.text.trimStart().startsWith('#EXTM3U')) return map;
  map[source.url] = master.text;
  if (master.text.includes('#EXT-X-STREAM-INF')) {
    const urls = playlistUrls(master.text, master.url || source.url).slice(0, 16);
    await Promise.all(urls.map(async u => {
      const r = await frameFetchText(tabId, u, origin);
      if (r && r.text.trimStart().startsWith('#EXTM3U')) map[u] = r.text;
    }));
  }
  return map;
}

// ---------- messages ----------

// Rebuild the pack-driven network rules after the installed packs changed.
async function afterSync(result) {
  await syncDynamicRules();
  return result;
}

async function handle(msg, sender) {
  const tabId = msg.tabId ?? sender.tab?.id;
  switch (msg.type) {
    case 'page': {
      const st = await getState(tabId);
      st.page = msg.info;
      st.meta = parsePage(msg.info, await packFor(msg.info?.url));
      saveState(tabId);
      if (st.sources.length) notify(tabId, st);
      return { ok: true };
    }
    case 'subs': {
      const st = await getState(tabId);
      const headers = { Referer: msg.frameUrl, Origin: originOf(msg.frameUrl) };
      for (const it of msg.items) {
        const old = st.subs.find(s => s.url === it.url);
        if (old) {
          old.label = it.label || old.label;
          old.lang = it.lang || old.lang;
        } else {
          st.subs.push({ ...it, headers, from: 'page' });
        }
      }
      saveState(tabId);
      return { ok: true };
    }
    case 'get-tab': {
      const st = await getState(tabId);
      try {
        const info = await chrome.tabs.sendMessage(tabId, { type: 'page-info' }, { frameId: 0 });
        if (info) { st.page = info; st.meta = parsePage(info, await packFor(info.url)); }
      } catch { /* page without content script (chrome://…) */ }
      return st;
    }
    case 'ui-strings': {
      // Content scripts cannot import modules: the overlay asks for its few strings here.
      const ui = await loadUiSettings();
      await initI18n(ui.lang);
      return { strings: Object.fromEntries((msg.keys || []).map(k => [k, t(k)])), theme: ui.theme, dir: isRtl() ? 'rtl' : 'ltr', lang: langTag() };
    }
    case 'whoami':
      return { tabId: sender.tab?.id ?? null };
    case 'prefetch':
      return { playlists: await prefetchPlaylists(tabId, msg.source, (await getState(tabId)).page?.url) };
    case 'trigger': {
      const st = await getState(tabId);
      const pack = await packFor(st.page?.url);
      await chrome.tabs.sendMessage(tabId, { type: 'trigger', player: pack?.player }).catch(() => {});
      return { ok: true };
    }
    case 'episodes': {
      const st = await getState(tabId);
      const links = await chrome.tabs.sendMessage(tabId, { type: 'links' }, { frameId: 0 }).catch(() => []);
      return { episodes: collectEpisodes(st.page?.url || '', links || [], await packFor(st.page?.url)) };
    }
    case 'queue-episodes':
      season.items.push(...msg.items.map(it => ({ ...it, options: msg.options })));
      season.total += msg.items.length;
      runSeason();
      return { ok: true };
    case 'season-status':
      return { ...season, items: season.items.length };
    case 'refresh-job': {
      const r = await resolvePage(msg.pageUrl);
      await api('POST', `/jobs/${msg.jobId}/retry`, { source: r.source, playlists: r.playlists, subtitles: r.subs });
      return { ok: true };
    }
    case 'packs-add-repo':
      return packs.addRepo(msg.url);
    case 'packs-trust-repo':
      return packs.trustRepo(msg.url);
    case 'packs-remove-repo':
      return afterSync(await packs.removeRepo(msg.url));
    case 'packs-list':
      return {
        repos: await packs.listRepos(),
        installed: await packs.installedPacks(),
        available: msg.url ? await packs.listAvailable(msg.url) : undefined,
      };
    case 'packs-install':
      return afterSync(await packs.installPack(msg.url, msg.id));
    case 'packs-uninstall':
      return afterSync(await packs.uninstallPack(msg.id));
    case 'packs-update':
      return afterSync(await packs.updateAll());
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, e => sendResponse({ error: e.message, code: e.code, errors: e.errors }));
  return true;
});

// ---------- daily pack updates ----------

function sayHelloToHelper() {
  try {
    chrome.runtime?.sendNativeMessage?.('com.reelheist.helper', { cmd: 'hello' }).catch(() => {});
  } catch { /* ignore */ }
}

function scheduleDaily() {
  chrome.alarms.create('packs-update', { periodInMinutes: 1440 });
  sayHelloToHelper();
}
chrome.runtime.onInstalled.addListener(scheduleDaily);
chrome.runtime.onStartup.addListener(scheduleDaily);
sayHelloToHelper();
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'packs-update') return;
  const { settings } = await chrome.storage.local.get('settings');
  if (settings?.autoUpdatePacks === false) return;
  await packs.updateAll().catch(() => {});
  await syncDynamicRules();
});

// ---------- season resolving ----------

const season = { running: false, total: 0, done: 0, failed: [], current: null, items: [] };

async function probeSource(s) {
  return api('POST', '/probe', { url: s.url, headers: s.headers, kind: s.kind, playlists: s.playlists });
}

// Probe every captured source (playlists read in the tab) and return the longest one.
async function pickSource(tabId, sources, pageUrl) {
  const playlistsByUrl = new Map();
  const list = await analyzeSources(sources, async s => {
    const playlists = await prefetchPlaylists(tabId, s, pageUrl);
    playlistsByUrl.set(s.url, playlists);
    return probeSource({ ...s, playlists });
  });
  const best = list[0];
  if (!best) return null;
  return {
    source: { kind: best.source.kind, url: best.source.url, headers: best.source.headers },
    playlists: playlistsByUrl.get(best.source.url) || null,
  };
}

let resolverWindowId = null;

async function openResolverTab(url) {
  if (resolverWindowId !== null) {
    try {
      const t = await chrome.tabs.create({ windowId: resolverWindowId, url, active: true });
      return t.id;
    } catch { resolverWindowId = null; }
  }
  const w = await chrome.windows.create({ url, state: 'minimized', focused: false });
  resolverWindowId = w.id;
  return w.tabs[0].id;
}

async function closeResolverWindow() {
  if (resolverWindowId === null) return;
  await chrome.windows.remove(resolverWindowId).catch(() => {});
  resolverWindowId = null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Open a page in the background, start its player, collect streams and subtitles.
async function resolvePage(url, timeoutMs = 60000) {
  const tabId = await openResolverTab(url);
  resolverTabs.add(tabId);
  chrome.tabs.update(tabId, { muted: true }).catch(() => {});
  try {
    const pack = await packFor(url);
    const deadline = Date.now() + timeoutMs;
    let firstFound = 0;
    while (Date.now() < deadline) {
      await sleep(2500);
      const st = await getState(tabId);
      if (st.sources.length) {
        if (!firstFound) firstFound = Date.now();
        // Give the player a moment to request the master playlist and subtitles.
        if (Date.now() - firstFound > 5000) break;
      } else {
        await chrome.tabs.sendMessage(tabId, { type: 'trigger', player: pack?.player }).catch(() => {});
      }
    }
    await chrome.tabs.sendMessage(tabId, { type: 'rescan' }).catch(() => {});
    await sleep(500);
    const st = await getState(tabId);
    if (!st.page) {
      st.page = await chrome.tabs.sendMessage(tabId, { type: 'page-info' }, { frameId: 0 }).catch(() => null);
    }
    if (!st.sources.length) throw Object.assign(new Error('No video found (timed out)'), { code: 'episode_timeout' });
    const best = await pickSource(tabId, st.sources, url);
    if (!best) throw Object.assign(new Error('The captured video addresses could not be read'), { code: 'episode_unreadable' });
    return {
      page: st.page,
      meta: st.page ? parsePage(st.page, await packFor(st.page.url || url)) : null,
      source: best.source,
      playlists: best.playlists,
      subs: st.subs.map(s => ({ url: s.url, label: s.label, lang: s.lang, headers: s.headers })),
    };
  } finally {
    resolverTabs.delete(tabId);
    await chrome.tabs.remove(tabId).catch(() => {});
    tabs.delete(tabId);
  }
}

async function runSeason() {
  if (season.running) return;
  season.running = true;
  try {
    while (season.items.length) {
      const it = season.items.shift();
      season.current = it;
      try {
        const r = await resolvePage(it.url);
        const o = it.options || {};
        await api('POST', '/jobs', {
          meta: { kind: 'episode', name: o.name || r.meta?.name || 'Dizi', season: it.season, episode: it.episode },
          pageUrl: it.url,
          source: r.source,
          playlists: r.playlists,
          quality: o.height ? { height: o.height } : null,
          audio: 'all',
          subtitles: r.subs,
          outDir: o.outDir || undefined,
        });
      } catch (e) {
        season.failed.push({ url: it.url, season: it.season, episode: it.episode, error: e.message, code: e.code });
      }
      season.done++;
    }
  } finally {
    season.current = null;
    season.running = false;
    await closeResolverWindow();
  }
}
