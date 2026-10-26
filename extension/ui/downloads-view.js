// Downloads list view: season groups (sticky header + episode cards with a five-step bar)
// and single job cards with preview square, pause/resume/cancel/retry/play/folder/remove.
import { api, getHelper } from '../lib/helper.js';
import { t, currentLang } from '../lib/i18n.js';
import { formatBytes, formatDuration } from '../lib/estimate.js';
import { staticFrameUrl } from '../lib/preview.js';
import { groupJobs, stepStates, subLine, summaryLine, dots } from '../lib/season.js';
import { loadUiSettings, saveUiSettings } from '../lib/ui-settings.js';
import { icon } from './icons.js';

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

const thumbCache = new Map(); // sourceUrl -> string | null (blob: or https: or null)

async function sha1Hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(String(str)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function resolveJobThumb(job) {
  const u = job?.source?.url;
  if (!u) return null;
  if (thumbCache.has(u)) return thumbCache.get(u);
  if (job.source.kind === 'ytdlp') {
    const ytImg = staticFrameUrl({ youtubeUrl: u });
    thumbCache.set(u, { type: 'img', src: ytImg });
    return thumbCache.get(u);
  }
  try {
    const id = await sha1Hex(u);
    const hp = await getHelper();
    const res = await fetch(`http://127.0.0.1:${hp.port}/api/preview/${id}`, {
      headers: { 'X-Token': hp.token },
      signal: AbortSignal.timeout(1500),
    });
    if (res.status === 200) {
      const blobUrl = URL.createObjectURL(await res.blob());
      thumbCache.set(u, { type: 'video', src: blobUrl });
      return thumbCache.get(u);
    }
  } catch { /* no cached preview */ }
  thumbCache.set(u, null);
  return null;
}

const pad2 = n => String(n ?? 0).padStart(2, '0');
// A job without an episode number shows "?" instead of a made-up 00.
const epNum = n => (Number.isFinite(n) ? pad2(n) : '?');
const epLabel = n => `E${epNum(n)}`;

// "site.example/series/x/season-1/episode-2" for a card line; the full URL goes to the title.
function shortPage(u) {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname.replace(/\/+$/, '')}`;
  } catch { return String(u || ''); }
}

// Waiting cards (queued, or resolving but not started) beyond this number fold into one line.
const SHOW_WAITING = 3;

export function createDownloadsView({ bg, errText, onRefresh }) {
  const $ = id => document.getElementById(id);
  const dur = sec => formatDuration(sec, currentLang());
  const bytes = n => formatBytes(n, currentLang());
  const stateText = st => t(`state_${st}`);

  let lastJobs = [];
  let ticking = new Map(); // job id -> { job, group } of cards whose counter moves every second
  let folded = null; // settings.seasonFolded: { [group.key]: true }
  const moreOpen = new Set(); // group keys whose folded waiting cards the user opened (this popup only)

  // The list is rebuilt every second, so an action error is kept here for a few seconds
  // and drawn again on each render instead of being written into a card that is about to go.
  const notes = new Map(); // job id or 'season:<key>' -> { text, until }
  const note = (id, text) => notes.set(id, { text, until: Date.now() + 8000 });
  function noteText(id) {
    const n = notes.get(id);
    if (n && n.until > Date.now()) return n.text;
    notes.delete(id);
    return '';
  }

  // The list is rebuilt every second. A card keeps its thumbnail element, so the preview
  // video is not made and loaded again on each render.
  const thumbEls = new Map(); // job id -> { url, el }
  function makeThumbEl(j) {
    const url = j?.source?.url || '';
    const kept = thumbEls.get(j.id);
    if (kept && kept.url === url) return kept.el;
    const box = h('div', { class: 'job-thumb' }, icon('film'));
    thumbEls.set(j.id, { url, el: box });
    const cached = thumbCache.get(j?.source?.url);
    const apply = item => {
      if (!item) return;
      if (item.type === 'img' && item.src) {
        box.replaceChildren(h('img', { src: item.src, alt: '' }));
      } else if (item.type === 'video' && item.src) {
        box.replaceChildren(h('video', { src: item.src, muted: true, playsinline: true, preload: 'metadata' }));
      }
    };
    if (cached !== undefined) apply(cached);
    else resolveJobThumb(j).then(apply);
    return box;
  }

  // Actions still running. The list is rebuilt every second, so the button of a running
  // action is drawn disabled again; a second click cannot start the action twice.
  const busy = new Set();

  // kind: 'primary' (filled), 'ghost' (icon + label), 'icon' (icon only, label goes to title/aria-label).
  // noteId: where an error of this action is shown (a job id or a season note id).
  const act = (label, fn, cls, iconName, kind, noteId) => {
    const key = `${noteId}|${cls}`;
    return h('button', {
      type: 'button',
      class: `act act-${kind} ${cls}`,
      title: kind === 'icon' ? label : null,
      'aria-label': kind === 'icon' ? label : null,
      disabled: busy.has(key),
      onclick: async e => {
        if (busy.has(key)) return;
        busy.add(key);
        e.currentTarget.disabled = true;
        try { await fn(); } catch (err) { note(noteId, errText(err)); } finally { busy.delete(key); }
        onRefresh?.();
      },
    }, iconName ? icon(iconName) : null, kind === 'icon' ? null : h('span', {}, label));
  };

  // Failed card: the helper puts a page/video failure back to 'resolving' and answers
  // resolve:true; the background resolver then takes the job in its turn.
  async function retryJob(j) {
    if (j.expired && j.pageUrl) return bg({ type: 'refresh-job', jobId: j.id, pageUrl: j.pageUrl });
    const r = await api('POST', `/jobs/${j.id}/retry`);
    if (r?.resolve) await bg({ type: 'resolve-job', jobId: j.id });
    return r;
  }

  async function cancelJob(j, action) {
    await api('POST', `/jobs/${j.id}/${action}`);
    // The resolver notices it within a few seconds; this closes its tab at once.
    if (j.state === 'resolving') bg({ type: 'cancel-resolve', jobId: j.id }).catch(() => {});
  }

  function stepsEl(j) {
    const s = stepStates(j);
    const kids = [];
    let prev = null;
    for (const [k, st] of Object.entries(s)) {
      // Subtitle-only jobs have no MP4 step; their "download" step is the subtitle fetch.
      if (j.subtitlesOnly && k === 'mux') continue;
      const label = j.subtitlesOnly && k === 'download' ? 'step_subs' : `step_${k}`;
      if (prev !== null) kids.push(h('i', { class: `ln${prev === 'done' ? ' done' : ''}` }));
      kids.push(h('span', { class: `st${st ? ` ${st}` : ''}` }, h('span', { class: 'dot' }), h('span', { class: 'st-l' }, t(label))));
      prev = st;
    }
    return h('div', { class: 'steps' }, kids);
  }

  function jobView(j, group = null) {
    const p = j.progress || {};
    const pct = j.state === 'done' ? 100 : Math.round(p.percent || 0);
    const running = ['downloading', 'muxing'].includes(j.state);
    const showBar = running || j.state === 'paused';
    const showPct = j.state === 'downloading' || (j.state === 'paused' && pct > 0) || (j.state === 'muxing' && p.percent != null);
    const sub = group ? subLine(j, group, Date.now()) : null;
    const waiting = sub?.key === 'queued_behind';
    const counting = sub?.key === 'resolve_waiting' || sub?.key === 'resolve_short_only';
    if (counting) ticking.set(j.id, { job: j, group });
    // A failed season card names its page; the error line under it says what went wrong.
    const failedPage = group && !sub && ['failed', 'canceled'].includes(j.state) && j.pageUrl;

    const info = [];
    if (j.state === 'downloading') {
      info.push(`${bytes(p.bytes)}${p.totalBytes ? ` / ${bytes(p.totalBytes)}` : ''}`);
      if (p.eta != null) info.push(p.eta > 90 ? t('eta_min', { n: Math.round(p.eta / 60) }) : t('eta_sec', { n: p.eta }));
      if (p.speed) info.push(t('speed', { n: (p.speed / 1e6).toFixed(1) }));
      if (p.connections) info.push(t('connections', { n: p.connections }));
    } else if (j.state === 'paused') {
      if (p.bytes) info.push(bytes(p.bytes));
    } else if (j.state === 'done' && j.subtitlesOnly) {
      info.push(t('badge_subs_only'), t('subs_count', { n: j.output?.subtitles?.length || 0 }));
    } else if (j.state === 'done') {
      info.push(bytes(j.output?.size));
      if (j.output?.subtitles?.length) info.push(t('subs_count', { n: j.output.subtitles.length }));
      if (j.stats?.totalMs) info.push(dur(Math.max(60, j.stats.totalMs / 1000)));
      if (j.stats?.avgSpeed) info.push(t('avg_speed', { n: (j.stats.avgSpeed / 1e6).toFixed(1) }));
    }

    const a = (label, fn, cls, iconName, kind = 'ghost') => act(label, fn, cls, iconName, kind, j.id);
    const actions = [];
    if (['downloading', 'queued'].includes(j.state)) {
      actions.push(a(t('btn_pause'), () => api('POST', `/jobs/${j.id}/pause`), 'btn-pause', 'pause'));
    }
    if (j.state === 'paused') {
      actions.push(a(t('btn_resume'), () => api('POST', `/jobs/${j.id}/retry`), 'btn-resume', 'play', 'primary'));
    }
    if (['failed', 'canceled'].includes(j.state)) {
      actions.push(a(t('btn_retry'), () => retryJob(j), 'btn-retry', 'retry', 'primary'));
      if (group && j.pageUrl) {
        actions.push(a(t('btn_open_page'), () => chrome.tabs.create({ url: j.pageUrl }), 'btn-open-page', null));
      }
    }
    if (j.state === 'done' && j.subtitlesOnly) {
      actions.push(a(t('btn_folder'), () => api('POST', `/jobs/${j.id}/open`), 'btn-folder', 'folder', 'primary'));
    } else if (j.state === 'done') {
      actions.push(a(t('btn_play'), () => api('POST', `/jobs/${j.id}/open?play=1`), 'btn-play', 'play', 'primary'));
      actions.push(a(t('btn_folder'), () => api('POST', `/jobs/${j.id}/open`), 'btn-folder', 'folder'));
    }
    if (['resolving', 'queued', 'downloading', 'muxing', 'paused'].includes(j.state)) {
      actions.push(a(t('btn_cancel'), () => cancelJob(j, 'cancel'), 'btn-cancel', 'close', 'icon'));
    }
    if (!running) {
      actions.push(a(t('btn_remove'), () => cancelJob(j, 'remove'), 'btn-remove', 'trash', 'icon'));
    }

    // The list is rebuilt every second; a negative delay keeps the stripes moving without a jump.
    const barStyle = `width:${pct}%;animation-delay:-${Date.now() % 700}ms`;

    const title = group && Number.isFinite(j.meta?.episode) ? `S${pad2(j.meta.season ?? group.season)}${epLabel(j.meta.episode)}` : j.names.base;
    const cls = ['job', j.state];
    if (group) cls.push('in-group');
    if (waiting) cls.push('waiting');
    else if (j.state === 'resolving') cls.push('finding');

    return h('div', { class: cls.join(' '), 'data-id': j.id },
      h('div', { class: 'job-top' },
        makeThumbEl(j),
        h('div', { class: 'job-main' },
          h('div', { class: 'title', title: j.names.base }, title),
          h('div', { class: 'job-sub' },
            sub
              ? h('span', { class: 'sub', 'data-tick': counting ? j.id : null }, t(sub.key, sub.params))
              : failedPage
                ? h('span', { class: 'job-page', title: j.pageUrl }, shortPage(j.pageUrl))
                : h('span', { class: 'job-state' }, stateText(j.state)),
            !sub && showPct ? h('span', { class: 'job-pct' }, t('percent', { n: pct })) : null,
          ),
        ),
      ),
      showBar ? h('div', { class: 'bar' }, h('i', { style: barStyle })) : null,
      group ? stepsEl(j) : null,
      info.length ? h('div', { class: 'job-info' }, info.join(' · ')) : null,
      j.error ? h('div', { class: 'err' }, errText({ code: j.errorCode, message: j.error })) : null,
      j.warning ? h('div', { class: 'warn' }, t(`warn_${j.warning}`, { detail: j.warningDetail || '' })) : null,
      h('div', { class: 'err', 'data-msg': '' }, noteText(j.id)),
      actions.length ? h('div', { class: 'actions' }, actions) : null);
  }

  function toggleFold(key) {
    const keys = new Set(groupJobs(lastJobs).groups.map(g => g.key));
    const next = {};
    for (const [k, v] of Object.entries(folded || {})) if (v && keys.has(k)) next[k] = true;
    if (!folded?.[key]) next[key] = true;
    else delete next[key];
    folded = next;
    saveUiSettings({ seasonFolded: next }).catch(() => {});
    paint();
  }

  function seasonHead(group, isFolded) {
    const total = Math.max(group.count || 0, group.jobs.length) || 1;
    const c = group.counts;
    let sum = summaryLine(group, isFolded);
    // Folded with nothing running or failed (a finished or waiting season): show the counts.
    if (!sum.parts.length) sum = summaryLine(group, false);
    const sumText = sum.parts
      .map(part => t(part.key, part.key.startsWith('ep_sum_') && part.key !== 'ep_sum_more'
        ? { ...part.params, n: epNum(part.params.n) }
        : part.params))
      .join(' · ');
    const w = n => `width:${(n / total) * 100}%`;
    const noteId = `season:${group.key}`;
    const sa = (label, fn, cls, iconName) => act(label, fn, cls, iconName, 'ghost', noteId);

    const buttons = [];
    if (c.failed) {
      buttons.push(sa(t('btn_retry_failed'), async () => {
        // One bad job does not stop the others; the first error is shown under the header.
        let first = null;
        for (const j of group.jobs.filter(x => ['failed', 'canceled'].includes(x.state))) {
          try { await retryJob(j); } catch (e) { first ??= e; }
        }
        if (first) throw first;
      }, 'btn-retry-failed', 'retry'));
    }
    if (group.allDone) {
      const first = group.jobs.find(j => j.state === 'done');
      // The series folder; every episode sits in its own folder inside it.
      buttons.push(sa(t('btn_folder'), () => api('POST', `/jobs/${first.id}/open?show=1`), 'btn-folder', 'folder'));
    }
    const label = t('season_head', { name: group.name, season: group.season });

    return h('div', {
      class: `season-head${isFolded ? ' folded' : ''}`,
      onclick: e => { if (!e.target.closest('button')) toggleFold(group.key); },
    },
      h('div', { class: 'season-main' },
        h('div', { class: 'season-title', title: label },
          h('span', { class: 'season-name' }, label),
          h('span', { class: 'season-count' }, ` · ${t('season_head_count', { n: total })}`)),
        h('div', { class: 'season-sum' },
          h('span', {}, sumText),
          isFolded ? h('span', { class: 'season-dots', 'aria-hidden': 'true' }, dots(group).map(d => h('i', { class: d }))) : null),
        h('div', { class: 'sbar', 'aria-hidden': 'true' },
          c.done ? h('i', { class: 'd', style: w(c.done) }) : null,
          c.active ? h('i', { class: 'c', style: w(c.active) }) : null,
          c.finding ? h('i', { class: 'c f', style: w(c.finding) }) : null,
          c.failed ? h('i', { class: 'e', style: w(c.failed) }) : null),
        h('div', { class: 'err', 'data-msg': '' }, noteText(noteId))),
      buttons,
      h('button', {
        type: 'button',
        class: 'chev',
        'aria-expanded': String(!isFolded),
        'aria-label': label,
        onclick: () => toggleFold(group.key),
      }, h('span', {}, '▾')));
  }

  function seasonView(group) {
    const isFolded = !!folded?.[group.key];
    const head = seasonHead(group, isFolded);
    if (isFolded) return h('div', { class: 'season' }, head);

    const cards = [];
    const waiting = group.jobs.filter(j => subLine(j, group, 0)?.key === 'queued_behind');
    const hidden = waiting.length > SHOW_WAITING && !moreOpen.has(group.key) ? new Set(waiting.slice(SHOW_WAITING)) : new Set();
    for (const j of group.jobs) if (!hidden.has(j)) cards.push(jobView(j, group));
    if (hidden.size) {
      const list = [...hidden].map(j => epLabel(j.meta?.episode)).join(', ');
      cards.push(h('button', {
        type: 'button',
        class: 'queued-more',
        'aria-expanded': 'false',
        onclick: () => { moreOpen.add(group.key); paint(); },
      }, `${t('queued_more', { list })} ▾`));
    }
    return h('div', { class: 'season' }, head, h('div', { class: 'season-body' }, cards));
  }

  function paint() {
    const box = $('jobs');
    if (!box) return;
    if (!lastJobs.length) {
      box.replaceChildren(h('div', { class: 'muted' }, t('queue_empty')));
      return;
    }
    const { groups, others } = groupJobs(lastJobs);
    ticking = new Map();
    box.replaceChildren(...groups.map(seasonView), ...others.map(j => jobView(j)));
    const ids = new Set(lastJobs.map(j => j.id));
    for (const id of thumbEls.keys()) if (!ids.has(id)) thumbEls.delete(id);
  }

  // The resolve counter ("18 / 90 s") moves on its own clock: a slow poll does not skip a second.
  function tick() {
    const box = $('jobs');
    if (!box) return;
    for (const el of box.querySelectorAll('[data-tick]')) {
      const cur = ticking.get(el.dataset.tick);
      const sub = cur && subLine(cur.job, cur.group, Date.now());
      if (!sub) continue;
      const text = t(sub.key, sub.params);
      if (el.textContent !== text) el.textContent = text;
    }
  }

  function wire() {
    setInterval(tick, 250);
    $('clearDone')?.addEventListener('click', async () => {
      const { jobs } = await api('GET', '/jobs');
      for (const j of jobs.filter(x => x.state === 'done')) await api('POST', `/jobs/${j.id}/remove`);
      onRefresh?.();
    });
  }

  // jobs: GET /jobs, polled every second by the popup.
  async function render(jobs = []) {
    if (!folded) folded = (await loadUiSettings().catch(() => ({}))).seasonFolded || {};
    lastJobs = jobs;
    paint();
  }

  // Helper unreachable: say so where the cards go. Cards that are already there stay, under
  // a line that says they are not up to date; the next good poll removes the line.
  function renderError(text) {
    const box = $('jobs');
    if (!box) return;
    if (!box.querySelector('.job, .season')) {
      box.replaceChildren(h('div', { class: 'status err' }, text));
      return;
    }
    let line = box.querySelector(':scope > .stale-note');
    if (!line) {
      line = h('div', { class: 'status err stale-note', role: 'status' });
      box.prepend(line);
    }
    if (line.textContent !== text) line.textContent = text;
  }

  return { wire, render, renderError };
}
