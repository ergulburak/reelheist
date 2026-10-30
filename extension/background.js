// Captures stream and subtitle URLs per tab, runs season resolving, talks to the helper.
import { parsePage, collectEpisodes, seriesKey } from './lib/titles.js';
import { api, requireFeature } from './lib/helper.js';
import { seasonKey, resolveOrder } from './lib/season.js';
import { analyzeSources } from './lib/sources.js';
import { youtubeTarget } from './lib/youtube.js';
import { initI18n, t, isRtl, currentLang, langTag } from './lib/i18n.js';
import { loadUiSettings } from './lib/ui-settings.js';
import { createStore } from './lib/packs/store.js';
import { createFollowStore } from './lib/follow-store.js';
import {
  epId, createFollow, diffFollow, toNotify, markNotified, prunePending, dismiss, followOptions, latestUrl, sameSeries,
  followNotifyKey,
} from './lib/follow.js';
import { syncDynamicRules as syncRules } from './lib/packs/dnr.js';

const packs = createStore({ storage: chrome.storage.local, fetch: globalThis.fetch.bind(globalThis) });
const followStore = createFollowStore(chrome.storage.local);

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
          // A stalled server must not hold the resolver: give up after 20 s.
          const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
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
    case 'queue-episodes': {
      const st = tabId != null ? await getState(tabId) : null;
      return queueEpisodes(msg.items || [], msg.options || {}, st?.meta?.name || '');
    }
    case 'follow-status': {
      const { pageUrl, pack } = await tabPage(tabId);
      return { follow: pageUrl ? await followStore.findByKey(seriesKey(pageUrl, pack)) : null };
    }
    case 'follow-add':
      return { follow: await addFollow(tabId, msg.name) };
    case 'follow-remove':
      await followStore.remove(msg.id);
      chrome.notifications.clear(`follow:${msg.id}`).catch(() => {});
      await ensureFollowAlarm();
      return { ok: true };
    case 'follow-list':
      return { follows: await prunedFollows() };
    case 'follow-check-now':
      return { result: await checkAllFollows() };
    case 'follow-download':
      return downloadFollow(msg.id, msg.ids || null);
    case 'follow-button': // the notification buttons' path; the e2e test drives it with this message
      await onFollowButton(msg.notificationId, msg.index);
      return { ok: true };
    case 'follow-dismiss':
      await followStore.update(msg.id, f => dismiss(f, msg.epId));
      return { ok: true };
    case 'resolve-job':
      // The helper already put the job back to 'resolving' (retry); the loop takes it in order.
      await runResolver();
      return { ok: true };
    case 'adopt-resolving':
      // Popup open: take waiting episodes, without the "search continues" toast (browser start only).
      return { ok: true, n: await runResolver() };
    case 'cancel-resolve':
      cancelResolve(msg.jobId);
      return { ok: true };
    case 'refresh-job': {
      try {
        const r = await resolveAttempt(msg.pageUrl);
        await api('POST', `/jobs/${msg.jobId}/retry`, { source: r.source, playlists: r.playlists, subtitles: r.subs });
      } finally {
        if (!resolverRunning) await closeResolverWindow();
      }
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
// Each season episode is a 'resolving' job in the helper. The loop below takes them one at a
// time, opens the page in a small window, captures the stream and reports every step back.

async function probeSource(s) {
  return api('POST', '/probe', { url: s.url, headers: s.headers, kind: s.kind, playlists: s.playlists });
}

// An episode is longer than this; anything shorter that answers first is a trailer or an ad.
const MIN_EPISODE_SEC = 120;

// Rejects with the signal's reason as soon as it fires; the work itself goes on in the background.
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

// Probe every captured source (playlists read in the tab) and return the longest one.
// cache: source URL → Promise<{playlists, probe}>, kept for the whole attempt so a new pick
// probes only the URLs it has not seen. A failed probe leaves the cache and is tried again.
async function pickSource(tabId, sources, pageUrl, { signal, cache = new Map() } = {}) {
  const probeOne = s => {
    if (!cache.has(s.url)) {
      const p = (async () => {
        const playlists = await prefetchPlaylists(tabId, s, pageUrl);
        return { playlists, probe: await probeSource({ ...s, playlists }) };
      })();
      cache.set(s.url, p);
      p.catch(() => { if (cache.get(s.url) === p) cache.delete(s.url); });
    }
    return cache.get(s.url);
  };
  const list = await untilAborted(
    analyzeSources(sources, async s => (await probeOne(s)).probe, { minDuration: MIN_EPISODE_SEC }),
    signal);
  const best = list[0];
  if (!best) return null;
  const known = await cache.get(best.source.url)?.catch(() => null);
  // A file source has no playlists ({}): send null, the same as "none cached".
  const playlists = known?.playlists && Object.keys(known.playlists).length ? known.playlists : null;
  return {
    source: { kind: best.source.kind, url: best.source.url, headers: best.source.headers },
    playlists,
    short: best.short,
  };
}

const RESOLVE_MS = 90000;
const HEARTBEAT_MS = 30000;
const PROBE_MARGIN_MS = 60000; // time after the deadline for the last pick and its probes

const coded = (code, message, step) => Object.assign(new Error(message), { code, step });

// 409 'state': the job left 'resolving' (canceled); 404 'job': it was removed.
const jobGone = e => e?.code === 'state' || e?.code === 'job';
const jobCall = (id, action, body) => api('POST', `/jobs/${id}/${action}`, body);

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

let resolverWindowId = null;
let spareTabId = null; // the window's last tab, kept blank between pages so the window stays
let resolverRunning = false;
let resolverAgain = false; // work was asked for while the loop was finishing
let resolverStopped = false; // the user closed the window
let resolverCurrent = null; // { job, ctrl } of the attempt in progress

// The window id also goes to session storage: a restarted service worker finds the window
// its earlier self left open and closes it.
function setResolverWindow(id) {
  resolverWindowId = id;
  chrome.storage.session.set({ resolverWindowId: id }).catch(() => {});
}

chrome.storage.session.get('resolverWindowId').then(({ resolverWindowId: left }) => {
  if (left != null && left !== resolverWindowId) chrome.windows.remove(left).catch(() => {});
}).catch(() => {});

// Opening and closing the window run one at a time: the season loop and a refresh-job
// opening at once would each make a window. The tab joins resolverTabs before the next
// step runs, so closeResolverWindow cannot close the window under a page that just opened.
let windowChain = Promise.resolve();
function inWindowChain(fn) {
  const run = windowChain.then(fn);
  windowChain = run.catch(() => {});
  return run;
}

function openResolverTab(url, signal) {
  return inWindowChain(async () => {
    signal?.throwIfAborted(); // canceled while waiting: no tab for a job that is gone
    const id = await openResolverTabNow(url);
    resolverTabs.add(id);
    return id;
  });
}

async function openResolverTabNow(url) {
  if (resolverWindowId !== null) {
    if (spareTabId !== null) {
      const id = spareTabId;
      spareTabId = null;
      try {
        resetState(id);
        await chrome.tabs.update(id, { url, active: true });
        return id;
      } catch { /* the tab is gone */ }
    }
    try {
      const t = await chrome.tabs.create({ windowId: resolverWindowId, url, active: true });
      return t.id;
    } catch { setResolverWindow(null); }
  }
  // Not minimized: a minimized window's page is "hidden", and the browser does not load or
  // play video in a hidden page, so no stream is ever requested. A small, unfocused window
  // in the corner of the user's window stays visible without taking the keyboard focus.
  const width = 480;
  const height = 320;
  const base = await chrome.windows.getLastFocused().catch(() => null);
  const corner = base?.width && base?.height
    ? { left: base.left + Math.max(0, base.width - width - 16), top: base.top + Math.max(0, base.height - height - 16) }
    : {};
  const w = await chrome.windows.create({ url, state: 'normal', focused: false, width, height, ...corner });
  setResolverWindow(w.id);
  return w.tabs[0].id;
}

// Closing the window's last tab would close the window: blank it and keep it for the next page.
async function closeResolverTab(tabId) {
  resolverTabs.delete(tabId);
  tabs.delete(tabId);
  const left = resolverWindowId === null ? [] : await chrome.tabs.query({ windowId: resolverWindowId }).catch(() => []);
  if (left.length === 1 && left[0].id === tabId) {
    await chrome.tabs.update(tabId, { url: 'about:blank' }).catch(() => {});
    spareTabId = tabId;
  } else {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

// Closes the window once no page in it is being resolved (refresh-job may share it).
function closeResolverWindow() {
  return inWindowChain(async () => {
    const id = resolverWindowId;
    if (id === null || resolverTabs.size) return;
    setResolverWindow(null); // ours: onRemoved must not treat it as the user closing it
    spareTabId = null;
    await chrome.windows.remove(id).catch(() => {});
  });
}

// The window shows the active tab's title: tell the user to leave it open.
function setResolverTitle(tabId, n) {
  chrome.tabs.sendMessage(tabId, { type: 'set-title', title: t('resolver_title', { n }) }, { frameId: 0 }).catch(() => {});
}

// One try at a page: open it, start its player, pick the episode stream.
// onStep(patch) reports progress; errors carry .code and .step ('page' or 'video').
async function resolveAttempt(url, { signal, onStep = async () => {}, n = 0 } = {}) {
  let tabId;
  try {
    tabId = await openResolverTab(url, signal);
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    throw coded('episode_timeout', `The page could not be opened (${e.message})`, 'page');
  }
  chrome.tabs.update(tabId, { muted: true }).catch(() => {});
  try {
    const pack = await packFor(url);
    const deadline = Date.now() + RESOLVE_MS;
    let firstFound = 0;
    let tries = 0;
    let best = null;
    let picked = 0; // number of sources the last pick looked at
    let opened = false; // the page answered: the search is at the 'video' step
    let shortSaid = false;
    const probes = new Map(); // probe results of this attempt, by source URL
    const pick = sources => pickSource(tabId, sources, url, { signal, cache: probes });
    while (Date.now() < deadline) {
      await wait(2500, signal);
      if (n) setResolverTitle(tabId, n); // pages change their title; this also keeps the worker awake
      const st = await getState(tabId);
      if (st.sources.length && !firstFound) firstFound = Date.now();
      // Give the player a moment to request the master playlist and subtitles.
      if (firstFound && Date.now() - firstFound > 5000) {
        if (st.sources.length !== picked) {
          picked = st.sources.length;
          best = await pick(st.sources);
          signal?.throwIfAborted();
        }
        // A trailer or an ad often plays first: keep waiting for the episode itself.
        if (best && !best.short) break;
        if (best?.short && !shortSaid) {
          shortSaid = true;
          await onStep({ note: 'short_only' });
        }
      }
      let answered = false;
      if (!st.sources.length || best?.short) {
        // Nobody watches this tab, so nobody clicks the poster: after two gentle tries,
        // let the trigger click play overlays in the top frame as well.
        tries++;
        answered = await chrome.tabs.sendMessage(tabId, { type: 'trigger', player: pack?.player, force: tries > 2 })
          .then(() => true, () => false);
      }
      if (!opened && (answered || st.page || st.sources.length)) {
        opened = true;
        await onStep({ step: 'video', note: 'waiting_player' });
      }
    }
    signal?.throwIfAborted();
    await chrome.tabs.sendMessage(tabId, { type: 'rescan' }).catch(() => {});
    await wait(500, signal);
    const st = await getState(tabId);
    if (!st.page) {
      st.page = await chrome.tabs.sendMessage(tabId, { type: 'page-info' }, { frameId: 0 }).catch(() => null);
    }
    // No content script ever answered: the page itself did not load (network error, no page).
    const step = opened || st.page ? 'video' : 'page';
    if (!st.sources.length) {
      throw coded('episode_timeout', step === 'page' ? 'The page did not load (timed out)' : 'No video found (timed out)', step);
    }
    if (!best || st.sources.length !== picked) best = await pick(st.sources);
    if (!best) throw coded('episode_unreadable', 'The captured video addresses could not be read', 'video');
    if (best.short) throw coded('episode_short', 'Only a short video was found (trailer or ad)', 'video');
    return {
      page: st.page,
      meta: st.page ? parsePage(st.page, await packFor(st.page.url || url)) : null,
      source: best.source,
      playlists: best.playlists,
      subs: st.subs.map(s => ({ url: s.url, label: s.label, lang: s.lang, headers: s.headers })),
    };
  } finally {
    await closeResolverTab(tabId);
  }
}

// Stop the attempt for this job (canceled or removed in the helper).
function cancelResolve(jobId) {
  if (resolverCurrent?.job.id === jobId) resolverCurrent.ctrl.abort(coded('state', 'state'));
}

// Two attempts (one automatic retry); the second failure stays on the card as an error.
async function resolveJob(job, n) {
  // Cards are canceled and removed in the helper directly: notice it and stop the tab.
  const watch = setInterval(async () => {
    const { jobs } = await api('GET', '/jobs').catch(() => ({}));
    const j = jobs?.find(x => x.id === job.id);
    if (jobs && j?.state !== 'resolving') cancelResolve(job.id);
  }, 3000);
  let cap = null; // hard end of the current attempt
  let capped = false; // the current attempt was stopped by the cap
  // Tells the helper's watchdog that this attempt is still alive (slow probes can pass its deadline).
  // No heartbeat after the attempt stopped, so a hung attempt cannot keep the card alive.
  const beat = setInterval(() => {
    const cur = resolverCurrent;
    if (cur?.job !== job || cur.ctrl.signal.aborted) return;
    jobCall(job.id, 'resolve', { heartbeat: Date.now() }).catch(() => {});
  }, HEARTBEAT_MS);
  try {
    for (let attempts = 1; attempts <= 2 && !resolverStopped; attempts++) {
      const ctrl = new AbortController();
      resolverCurrent = { job, ctrl };
      let step = 'page'; // last step the attempt reported
      const write = patch => {
        if (patch.step) step = patch.step;
        return jobCall(job.id, 'resolve', patch);
      };
      const startedAt = Date.now();
      capped = false;
      // A stalled playlist server must not hang the season: stop the attempt at
      // startedAt + deadline + the probe margin, then fail it like any other attempt.
      cap = setTimeout(() => {
        capped = true;
        ctrl.abort(coded('episode_timeout', `Attempt cap reached`, step));
      }, RESOLVE_MS + PROBE_MARGIN_MS);
      try {
        await write({ step: 'page', note: 'opening', attempts, startedAt, deadlineMs: RESOLVE_MS });
        const r = await resolveAttempt(job.pageUrl, { signal: ctrl.signal, onStep: write, n });
        // No meta here: the name was fixed when the card was made (resolved.meta would rename).
        await jobCall(job.id, 'resolved', { source: r.source, playlists: r.playlists, subtitles: r.subs });
        return;
      } catch (e) {
        if (jobGone(e) || jobGone(ctrl.signal.reason)) return; // canceled or removed: next job
        if (ctrl.signal.aborted && !capped) {
          // The user closed the window: the episode waits again ("queued"), it did not fail.
          await write({ step: 'page', startedAt: null, note: null, attempts: 0 }).catch(() => {});
          return;
        }
        if (/^helper_/.test(e.code || '')) throw e; // the helper is gone: stop the loop
        if (attempts === 1) continue;
        const f = capped ? ctrl.signal.reason : e.step ? e : coded('episode_unreadable', e.message, 'video');
        await jobCall(job.id, 'fail', { code: f.code, detail: f.message, step: f.step }).catch(() => {});
      } finally {
        clearTimeout(cap);
      }
    }
  } finally {
    clearInterval(watch);
    clearInterval(beat);
    clearTimeout(cap);
    resolverCurrent = null;
  }
}

// Episodes that wait for the resolver, in season order.
async function pendingJobs() {
  const { jobs } = await api('GET', '/jobs');
  return jobs
    .filter(j => j.state === 'resolving' && !j.resolve?.startedAt)
    .sort(resolveOrder);
}

// Start the loop if episodes wait. Answers how many it took; the loop goes on by itself.
// resume: work left from an earlier session, so the helper shows "season search continues".
async function runResolver({ resume = false } = {}) {
  if (resolverRunning) {
    // New work after the user closed the window: the loop goes on (or starts again).
    resolverAgain = true;
    resolverStopped = false;
    return 0;
  }
  resolverRunning = true;
  resolverStopped = false;
  resolverAgain = false;
  let list;
  try {
    list = await pendingJobs();
  } catch (e) {
    resolverRunning = false;
    throw e;
  }
  if (!list.length) {
    resolverRunning = false;
    return 0;
  }
  resolverLoop(list, resume);
  return list.length;
}

async function resolverLoop(list, resume) {
  try {
    await initI18n((await loadUiSettings()).lang).catch(() => {});
    if (resume) await jobCall(list[0].id, 'resolve', { note: 'resume', remaining: list.length }).catch(() => {});
    while (list.length && !resolverStopped) {
      await resolveJob(list[0], list.length);
      list = await pendingJobs();
    }
  } catch { /* helper unreachable: the cards stay; the next start picks them up */ }
  finally {
    resolverRunning = false;
    resolverCurrent = null;
    await closeResolverWindow();
    if (resolverAgain && !resolverStopped) runResolver().catch(() => {});
  }
}

// The user (or the browser shutting down) closed the resolver window.
chrome.windows.onRemoved.addListener(windowId => {
  if (windowId !== resolverWindowId) return;
  setResolverWindow(null);
  spareTabId = null;
  resolverStopped = true;
  const cur = resolverCurrent;
  if (!cur) return;
  // Reset at once (the browser may be quitting); resolveJob writes it again after the abort.
  jobCall(cur.job.id, 'resolve', { step: 'page', startedAt: null, note: null, attempts: 0 }).catch(() => {});
  cur.ctrl.abort(new Error('Resolver window closed'));
});

// Browser start: episodes that never started go on without the user.
chrome.runtime.onStartup.addListener(() => { runResolver({ resume: true }).catch(() => {}); });

// ---------- queueing season episodes ----------

// Every episode becomes a card (a 'resolving' job) now; the resolver finds the videos later.
// o: {name, height, subtitlesOnly, embedSubs, outDir}; the popup sends them, a follow download
// builds them from the stored settings (followOptions).
async function queueEpisodes(items, o = {}, fallbackName = '') {
  const name = String(o.name || '').trim() || fallbackName;
  if (!name) throw Object.assign(new Error('Series name is required'), { code: 'name_required' });
  // An older helper would take these source-less jobs as broken downloads.
  await requireFeature('season');
  if (o.subtitlesOnly) await requireFeature('subs-only');
  const { jobs: known } = await api('GET', '/jobs');
  const groupOf = season => {
    const key = seasonKey(name, season);
    // count: every episode of this season in the queue, the earlier ones included.
    const urls = new Set(known.filter(j => j.group?.key === key).map(j => j.pageUrl));
    for (const it of items) if (it.season === season) urls.add(it.url);
    return { key, name, season, count: urls.size };
  };
  const r = await api('POST', '/jobs', {
    jobs: items.map(it => ({
      state: 'resolving',
      pageUrl: it.url,
      meta: { kind: 'episode', name, season: it.season, episode: it.episode },
      group: groupOf(it.season),
      quality: o.height ? { height: o.height } : null,
      audio: 'all',
      subtitlesOnly: Boolean(o.subtitlesOnly),
      embedSubs: o.embedSubs || null,
      outDir: o.outDir || undefined,
    })),
  });
  runResolver().catch(() => {});
  return { ok: true, added: r.ids.length - r.reused.length - r.skipped.length, reused: r.reused.length, skipped: r.skipped.length };
}

// ---------- follow a series ----------
// A follow is a series page the user follows (lib/follow.js, lib/follow-store.js). A check opens
// the page in the resolver window, reads its episode links and asks before anything downloads:
// a notification with "Download" / "Not now", and a card in the popup.

const FOLLOW_PERIOD_MIN = 360; // every 6 hours while the browser is open
const FOLLOW_RETRY_MIN = 10; // a season search was running: try again later
const FOLLOW_CHECK_MS = 60000; // one page may take this long at most
let followChecking = false;

async function tabPage(tabId) {
  if (tabId == null) return { pageUrl: '', pack: null };
  const st = await getState(tabId);
  const pageUrl = st.page?.url || (await chrome.tabs.get(tabId).catch(() => null))?.url || '';
  return { pageUrl, pack: await packFor(pageUrl), st };
}

async function addFollow(tabId, name) {
  const { pageUrl, pack, st } = await tabPage(tabId);
  const links = await chrome.tabs.sendMessage(tabId, { type: 'links' }, { frameId: 0 }).catch(() => []);
  const episodes = collectEpisodes(pageUrl, links || [], pack);
  if (!episodes.length) throw Object.assign(new Error('No episode list on this page'), { code: 'follow_no_list' });
  const n = String(name || '').trim() || st?.meta?.name || '';
  if (!n) throw Object.assign(new Error('Series name is required'), { code: 'name_required' });
  const follow = await followStore.add(createFollow({ url: pageUrl, name: n, key: seriesKey(pageUrl, pack), episodes }));
  await ensureFollowAlarm();
  return follow;
}

function waitTabComplete(tabId, signal) {
  return new Promise((resolve, reject) => {
    const poll = setInterval(async () => {
      if (signal?.aborted) return done(() => reject(signal.reason));
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return done(() => reject(new Error('tab closed')));
      if (tab.status === 'complete') done(resolve);
    }, 500);
    const done = fn => { clearInterval(poll); fn(); };
  });
}

// The episode list of one page, read in the resolver window; [] when the page has none, or when
// the site sent it to another series (expectKey: the follow's key; another host is fine).
async function readEpisodes(url, signal, expectKey = '') {
  const tabId = await openResolverTab(url, signal);
  chrome.tabs.update(tabId, { muted: true }).catch(() => {});
  try {
    await waitTabComplete(tabId, signal);
    await wait(3000, signal); // let the page script draw its list
    const pageUrl = (await chrome.tabs.get(tabId).catch(() => null))?.url || url;
    const pack = await packFor(pageUrl);
    if (expectKey && !sameSeries(expectKey, seriesKey(pageUrl, pack))) return [];
    const links = await chrome.tabs.sendMessage(tabId, { type: 'links' }, { frameId: 0 }).catch(() => []);
    return collectEpisodes(pageUrl, links || [], pack);
  } finally {
    await closeResolverTab(tabId);
  }
}

// Checks one follow: the followed page first, the newest known episode page when that gives
// nothing. A failed check changes nothing but lastError.
async function checkFollow(follow) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('Follow check timed out')), FOLLOW_CHECK_MS);
  let episodes = [];
  try {
    episodes = await readEpisodes(follow.url, ctrl.signal, follow.key);
    const last = latestUrl(follow);
    if (!episodes.length && last && last !== follow.url) episodes = await readEpisodes(last, ctrl.signal, follow.key);
  } catch { episodes = []; } finally {
    clearTimeout(timer);
  }
  const { jobs } = await api('GET', '/jobs').catch(() => ({ jobs: [] }));
  return followStore.update(follow.id, f => prunePending(diffFollow(f, episodes).follow, jobs));
}

// 'done', or 'busy' when a season search runs (it owns the window; a retry alarm is set).
async function checkAllFollows() {
  const busy = () => {
    chrome.alarms.create('follow-retry', { delayInMinutes: FOLLOW_RETRY_MIN });
    return 'busy';
  };
  if (resolverRunning || followChecking) return busy();
  followChecking = true;
  try {
    await initI18n((await loadUiSettings()).lang).catch(() => {});
    for (const f of await followStore.list()) {
      if (resolverRunning) return busy();
      const checked = await checkFollow(f);
      if (checked) await notifyFollow(checked);
    }
    return 'done';
  } finally {
    followChecking = false;
    if (!resolverRunning) await closeResolverWindow();
  }
}

const epLabel = e => `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;

// One notification per follow, only when a check finds episodes never asked about. A notification
// that is still open is replaced: the new one asks about its episodes and the earlier ones together.
async function notifyFollow(follow) {
  const fresh = toNotify(follow);
  if (!fresh.length) return;
  const key = `follownote:${follow.id}`;
  const open = new Set((await chrome.storage.session.get(key))[key] || []);
  for (const e of fresh) open.add(epId(e.season, e.episode));
  const items = follow.pending.filter(p => open.has(epId(p.season, p.episode)));
  const ids = items.map(e => epId(e.season, e.episode));
  const list = items.slice(0, 3).map(epLabel).join(', ') + (items.length > 3 ? ` +${items.length - 3}` : '');
  await chrome.notifications.create(`follow:${follow.id}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'ReelHeist',
    message: t(followNotifyKey(items.length), { name: follow.name, n: items.length, list }),
    buttons: [{ title: t('btn_download') }, { title: t('follow_not_now') }],
    requireInteraction: true,
  });
  // The "Download" button takes the episodes this notification asked about.
  await chrome.storage.session.set({ [key]: ids });
  await followStore.update(follow.id, f => markNotified(f, ids));
}

// Queues pending episodes of a follow (ids: those to take; null: all of them).
async function downloadFollow(id, ids) {
  const follow = (await followStore.list()).find(f => f.id === id);
  if (!follow) throw Object.assign(new Error('This series is not followed'), { code: 'bad_request' });
  const want = ids ? new Set(ids) : null;
  const items = follow.pending
    .filter(p => !want || want.has(epId(p.season, p.episode)))
    .map(p => ({ url: p.url, season: p.season, episode: p.episode }));
  if (!items.length) return { ok: true, added: 0, reused: 0, skipped: 0 };
  const ui = await loadUiSettings();
  await initI18n(ui.lang).catch(() => {});
  const r = await queueEpisodes(items, followOptions(ui, currentLang(), follow.name), follow.name);
  const { jobs } = await api('GET', '/jobs');
  await followStore.update(id, f => prunePending(f, jobs));
  return r;
}

// The popup shows pending episodes; the ones that went to the queue meanwhile leave the card.
async function prunedFollows() {
  const list = await followStore.list();
  const { jobs } = await api('GET', '/jobs').catch(() => ({ jobs: null }));
  if (!jobs) return list;
  const out = [];
  for (const f of list) {
    const pruned = prunePending(f, jobs);
    out.push(pruned === f ? f : (await followStore.update(f.id, x => prunePending(x, jobs))) || pruned);
  }
  return out;
}

// The check alarm runs only while there is something to check.
async function ensureFollowAlarm(reset = false) {
  if (!(await followStore.list()).length) return chrome.alarms.clear('follow-check');
  if (!reset && await chrome.alarms.get('follow-check')) return;
  chrome.alarms.create('follow-check', { delayInMinutes: 1, periodInMinutes: FOLLOW_PERIOD_MIN });
}

chrome.runtime.onStartup.addListener(() => { ensureFollowAlarm(true).catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { ensureFollowAlarm().catch(() => {}); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'follow-check' || alarm.name === 'follow-retry') checkAllFollows().catch(() => {});
});

async function onFollowButton(nid, index) {
  if (!String(nid).startsWith('follow:')) return;
  const id = nid.slice('follow:'.length);
  chrome.notifications.clear(nid).catch(() => {});
  const key = `follownote:${id}`;
  const ids = (await chrome.storage.session.get(key))[key] || null;
  chrome.storage.session.remove(key).catch(() => {});
  // "Not now": the episodes stay on the popup card and are not announced again.
  if (index !== 0) return;
  try {
    await downloadFollow(id, ids);
  } catch (e) {
    // The user pressed "Download" and the popup may be closed: say what went wrong.
    await initI18n((await loadUiSettings()).lang).catch(() => {});
    const code = e?.code ? `err_${e.code}` : '';
    const text = code && t(code) !== code ? t(code) : (e?.message || String(e));
    await chrome.notifications.create(`follow-error:${id}`, {
      type: 'basic', iconUrl: 'icons/icon128.png', title: 'ReelHeist', message: t('follow_download_failed', { error: text }),
    }).catch(() => {});
  }
}

chrome.notifications.onButtonClicked.addListener((nid, index) => { onFollowButton(nid, index).catch(() => {}); });
// Closed without an answer: the next notification asks only about what it finds.
chrome.notifications.onClosed.addListener(nid => {
  if (nid.startsWith('follow:')) chrome.storage.session.remove(`follownote:${nid.slice('follow:'.length)}`).catch(() => {});
});
