// Downloads list view: job cards with preview square, pause/resume/cancel/retry/play/folder/remove.
import { api, getHelper } from '../lib/helper.js';
import { t, currentLang } from '../lib/i18n.js';
import { formatBytes, formatDuration } from '../lib/estimate.js';
import { staticFrameUrl } from '../lib/preview.js';
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

export function createDownloadsView({ bg, errText, onRefresh }) {
  const $ = id => document.getElementById(id);
  const dur = sec => formatDuration(sec, currentLang());
  const bytes = n => formatBytes(n, currentLang());
  const stateText = st => t(`state_${st}`);

  function setStatus(el, text, isError = false) {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('err', isError);
    el.hidden = !text;
  }

  function alertJob(id, text) {
    const el = document.querySelector(`.job[data-id="${id}"] [data-msg]`);
    if (el) el.textContent = text;
  }

  function makeThumbEl(j) {
    const box = h('div', { class: 'job-thumb' }, icon('film'));
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

  function jobView(j) {
    const p = j.progress || {};
    const pct = j.state === 'done' ? 100 : Math.round(p.percent || 0);
    const running = ['downloading', 'muxing'].includes(j.state);
    const showBar = running || j.state === 'paused';
    const showPct = j.state === 'downloading' || (j.state === 'paused' && pct > 0) || (j.state === 'muxing' && p.percent != null);

    const info = [];
    if (j.state === 'downloading') {
      info.push(`${bytes(p.bytes)}${p.totalBytes ? ` / ${bytes(p.totalBytes)}` : ''}`);
      if (p.eta != null) info.push(p.eta > 90 ? t('eta_min', { n: Math.round(p.eta / 60) }) : t('eta_sec', { n: p.eta }));
      if (p.speed) info.push(t('speed', { n: (p.speed / 1e6).toFixed(1) }));
      if (p.connections) info.push(t('connections', { n: p.connections }));
    } else if (j.state === 'paused') {
      if (p.bytes) info.push(bytes(p.bytes));
    } else if (j.state === 'done') {
      info.push(bytes(j.output?.size));
      if (j.output?.subtitles?.length) info.push(t('subs_count', { n: j.output.subtitles.length }));
      if (j.stats?.totalMs) info.push(dur(Math.max(60, j.stats.totalMs / 1000)));
      if (j.stats?.avgSpeed) info.push(t('avg_speed', { n: (j.stats.avgSpeed / 1e6).toFixed(1) }));
    }

    // kind: 'primary' (filled), 'ghost' (icon + label), 'icon' (icon only, label goes to title/aria-label).
    const act = (label, fn, cls, iconName, kind = 'ghost') => h('button', {
      type: 'button',
      class: `act act-${kind} ${cls}`,
      title: kind === 'icon' ? label : null,
      'aria-label': kind === 'icon' ? label : null,
      onclick: async e => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try { await fn(); } catch (err) { alertJob(j.id, errText(err)); }
        onRefresh?.();
      },
    }, icon(iconName), kind === 'icon' ? null : h('span', {}, label));

    const actions = [];
    if (['downloading', 'queued'].includes(j.state)) {
      actions.push(act(t('btn_pause'), () => api('POST', `/jobs/${j.id}/pause`), 'btn-pause', 'pause'));
    }
    if (j.state === 'paused') {
      actions.push(act(t('btn_resume'), () => api('POST', `/jobs/${j.id}/retry`), 'btn-resume', 'play', 'primary'));
    }
    if (['failed', 'canceled'].includes(j.state)) {
      actions.push(act(t('btn_retry'), () => (j.expired && j.pageUrl
        ? bg({ type: 'refresh-job', jobId: j.id, pageUrl: j.pageUrl })
        : api('POST', `/jobs/${j.id}/retry`)), 'btn-retry', 'retry', 'primary'));
    }
    if (j.state === 'done') {
      actions.push(act(t('btn_play'), () => api('POST', `/jobs/${j.id}/open?play=1`), 'btn-play', 'play', 'primary'));
      actions.push(act(t('btn_folder'), () => api('POST', `/jobs/${j.id}/open`), 'btn-folder', 'folder'));
    }
    if (['queued', 'downloading', 'muxing', 'paused'].includes(j.state)) {
      actions.push(act(t('btn_cancel'), () => api('POST', `/jobs/${j.id}/cancel`), 'btn-cancel', 'close', 'icon'));
    }
    if (!running) {
      actions.push(act(t('btn_remove'), () => api('POST', `/jobs/${j.id}/remove`), 'btn-remove', 'trash', 'icon'));
    }

    // The list is rebuilt every second; a negative delay keeps the stripes moving without a jump.
    const barStyle = `width:${pct}%;animation-delay:-${Date.now() % 700}ms`;

    return h('div', { class: `job ${j.state}`, 'data-id': j.id },
      h('div', { class: 'job-top' },
        makeThumbEl(j),
        h('div', { class: 'job-main' },
          h('div', { class: 'title', title: j.names.base }, j.names.base),
          h('div', { class: 'job-sub' },
            h('span', { class: 'job-state' }, stateText(j.state)),
            showPct ? h('span', { class: 'job-pct' }, t('percent', { n: pct })) : null,
          ),
        ),
      ),
      showBar ? h('div', { class: 'bar' }, h('i', { style: barStyle })) : null,
      info.length ? h('div', { class: 'job-info' }, info.join(' · ')) : null,
      j.error ? h('div', { class: 'err' }, errText({ code: j.errorCode, message: j.error })) : null,
      j.warning ? h('div', { class: 'warn' }, t(`warn_${j.warning}`, { detail: j.warningDetail || '' })) : null,
      h('div', { class: 'err', 'data-msg': '' }),
      h('div', { class: 'actions' }, actions));
  }

  function wire() {
    $('clearDone')?.addEventListener('click', async () => {
      const { jobs } = await api('GET', '/jobs');
      for (const j of jobs.filter(x => x.state === 'done')) await api('POST', `/jobs/${j.id}/remove`);
      onRefresh?.();
    });
  }

  async function render(jobs = []) {
    const box = $('jobs');
    if (box) {
      box.replaceChildren(...(jobs.length ? [...jobs].reverse().map(jobView) : [h('div', { class: 'muted' }, t('queue_empty'))]));
    }
    if (!$('queue').hidden) {
      const s = await bg({ type: 'season-status' });
      const parts = [];
      if (s.running) {
        parts.push(s.current
          ? t('season_progress_current', { done: s.done, total: s.total, n: s.current.episode })
          : t('season_progress', { done: s.done, total: s.total }));
      }
      for (const f of s.failed || []) {
        parts.push(t('season_failed', { season: f.season, episode: f.episode, error: errText({ code: f.code, message: f.error }) }));
      }
      setStatus($('seasonStatus'), parts.join('\n'), (s.failed || []).length > 0);
    }
  }

  return { wire, render, setStatus };
}
