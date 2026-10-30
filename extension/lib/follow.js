// "Follow a series": pure calculations on one follow record. No storage, no DOM, no chrome APIs.
// An episode is known by its season and episode number, not by its address: a site that moves
// to another domain does not make every episode new. Every function returns a new record.
//
// Follow = { id, key, name, url, seen: string[], urls: {[epId]: string},
//            pending: [{season, episode, url}], notified: string[],
//            lastCheck: number, lastError: string|null, createdAt: number }
import { seasonKey } from './season.js';
import { embedSubsOption } from './defaults.js';

export const epId = (season, episode) => `${season}x${episode}`;

// Series keys are "host/path" (lib/titles.js seriesKey). The same path on another host is the same
// series (the site moved); another path is another series (a redirect to a different page).
export function sameSeries(a, b) {
  const path = k => { const s = String(k || ''); const i = s.indexOf('/'); return i < 0 ? '' : s.slice(i); };
  return !!path(a) && path(a) === path(b);
}

const idOf = e => epId(e.season, e.episode);
const byNumber = (a, b) => a.season - b.season || a.episode - b.episode;

function newId() {
  return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Every episode on the page when the user starts to follow counts as seen.
export function createFollow({ url, name, key, episodes, now = Date.now() }) {
  const urls = {};
  for (const e of episodes) urls[idOf(e)] = e.url;
  return {
    id: newId(),
    key,
    name,
    url,
    seen: [...new Set(episodes.slice().sort(byNumber).map(idOf))],
    urls,
    pending: [],
    notified: [],
    lastCheck: now,
    lastError: null,
    createdAt: now,
  };
}

// New = an episode number never seen before (a late episode in an old season too).
// An empty list is a failed check: nothing is new and the error is kept.
export function diffFollow(follow, episodes, now = Date.now()) {
  if (!episodes.length) return { follow: { ...follow, lastCheck: now, lastError: 'empty' }, added: [] };
  const seen = new Set(follow.seen);
  const urls = { ...follow.urls };
  const added = [];
  for (const e of episodes.slice().sort(byNumber)) {
    const id = idOf(e);
    urls[id] = e.url;
    if (!seen.has(id)) {
      seen.add(id);
      added.push({ season: e.season, episode: e.episode, url: e.url });
    }
  }
  // Pending episodes take the newest address too.
  const pending = [...follow.pending.map(p => ({ ...p, url: urls[idOf(p)] || p.url })), ...added];
  return { follow: { ...follow, seen: [...seen], urls, pending, lastCheck: now, lastError: null }, added };
}

// Pending episodes that no notification has asked about yet.
export function toNotify(follow) {
  const done = new Set(follow.notified);
  return follow.pending.filter(p => !done.has(idOf(p)));
}

export function markNotified(follow, ids) {
  return { ...follow, notified: [...new Set([...follow.notified, ...ids])] };
}

// An episode leaves the card once it is in the queue, by any path and in any state: a season job
// (same series and number) or a single download from the episode's own page (same address, the
// helper's own identity rule).
export function prunePending(follow, jobs = []) {
  const queued = new Set();
  const pages = new Set();
  for (const j of jobs) {
    if (j?.group?.key && Number.isFinite(j.meta?.episode)) queued.add(`${j.group.key}|${j.meta.episode}`);
    if (j?.pageUrl) pages.add(j.pageUrl);
  }
  const pending = follow.pending.filter(p => !queued.has(`${seasonKey(follow.name, p.season)}|${p.episode}`) && !pages.has(p.url));
  return pending.length === follow.pending.length ? follow : { ...follow, pending };
}

// "Remove" on the card: the episode stays seen, so it does not come back.
export function dismiss(follow, id) {
  return { ...follow, pending: follow.pending.filter(p => idOf(p) !== id) };
}

// The address of the newest known episode: a second page to try when the followed page fails.
export function latestUrl(follow) {
  let best = null;
  for (const [id, url] of Object.entries(follow.urls || {})) {
    const [season, episode] = id.split('x').map(Number);
    if (!best || season > best.season || (season === best.season && episode > best.episode)) best = { season, episode, url };
  }
  return best ? best.url : null;
}

// Queue options for a download that starts from a notification, with no popup open:
// the same defaults the popup would use.
export function followOptions(ui, uiLang, name) {
  return {
    name,
    height: ui?.defaults?.quality || null,
    subtitlesOnly: false,
    embedSubs: embedSubsOption(ui, uiLang),
  };
}

// The notification text key: one episode reads in the singular.
export const followNotifyKey = n => (n === 1 ? 'follow_notify_one' : 'follow_notify');
