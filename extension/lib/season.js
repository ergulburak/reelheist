// Pure season-group computation for the queue view. No DOM, no i18n:
// functions return keys and params, the view translates them.

const STEPS = ['page', 'video', 'download', 'mux', 'done'];

function started(job) {
  return job.state === 'resolving' && !!(job.resolve && job.resolve.startedAt);
}

// Episode number, or null when the job has none.
function epOf(job) {
  return job.meta && Number.isFinite(job.meta.episode) ? job.meta.episode : null;
}

// Sort position: a job without an episode number goes after the numbered ones.
function orderOf(job) {
  const ep = epOf(job);
  return ep === null ? Infinity : ep;
}

const byOrder = (a, b) => orderOf(a) - orderOf(b) || (a.createdAt || 0) - (b.createdAt || 0);

// Display kind: done | active | finding | failed | queued
function kindOf(job) {
  switch (job.state) {
    case 'done': return 'done';
    case 'downloading': case 'muxing': case 'paused': return 'active';
    case 'failed': case 'canceled': return 'failed';
    case 'resolving': return started(job) ? 'finding' : 'queued';
    default: return 'queued';
  }
}

// Sort rank inside a group: running, failed, done, waiting.
const RANK = { active: 0, finding: 0, failed: 1, done: 2, queued: 3 };

function buildGroup(jobs) {
  const sorted = jobs.slice().sort((a, b) => RANK[kindOf(a)] - RANK[kindOf(b)] || byOrder(a, b));
  const counts = { done: 0, active: 0, finding: 0, failed: 0, queued: 0 };
  for (const j of sorted) counts[kindOf(j)]++;
  // Cards made at different times can carry different counts: the newest card names the
  // group, and the count is never below the cards that are there.
  const latest = jobs.reduce((a, b) => ((b.createdAt || 0) > (a.createdAt || 0) ? b : a)).group;
  const count = Math.max(jobs.length, ...jobs.map((j) => Number(j.group.count) || 0));
  return {
    key: latest.key,
    name: latest.name,
    season: latest.season,
    count,
    jobs: sorted,
    counts,
    allDone: sorted.length > 0 && counts.done === sorted.length,
  };
}

export function groupJobs(jobs) {
  const byKey = new Map();
  const others = [];
  for (const j of jobs) {
    if (j.group && j.group.key) {
      if (!byKey.has(j.group.key)) byKey.set(j.group.key, []);
      byKey.get(j.group.key).push(j);
    } else {
      others.push(j);
    }
  }
  const newest = (g) => Math.max(...g.jobs.map((j) => j.createdAt || 0));
  const groups = [...byKey.values()]
    .map(buildGroup)
    .sort((a, b) => newest(b) - newest(a));
  others.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { groups, others };
}

export function stepStates(job) {
  const out = { page: '', video: '', download: '', mux: '', done: '' };
  const { state } = job;
  if (state === 'resolving' && !started(job)) return out;
  if (state === 'failed' || state === 'canceled') {
    // Steps before the failed step are done; the failed step is err.
    const at = STEPS.indexOf(job.stepError || job.step);
    for (let i = 0; i < STEPS.length; i++) {
      if (i < at) out[STEPS[i]] = 'done';
      else if (i === at && job.stepError) out[STEPS[i]] = 'err';
    }
    return out;
  }
  if (job.step !== 'page' || state !== 'resolving') out.page = 'done';
  if (['queued', 'downloading', 'muxing', 'paused', 'done'].includes(state)) out.video = 'done';
  if (state === 'muxing' || state === 'done') out.download = 'done';
  if (state === 'done') { out.mux = 'done'; out.done = 'done'; }
  const now = state === 'resolving' ? job.step
    : state === 'downloading' || state === 'paused' ? 'download'
    : state === 'muxing' ? 'mux' : null;
  if (now && out[now] === '') out[now] = 'now';
  return out;
}

function waitingBefore(job, group) {
  if (!group) return 0;
  return group.jobs.filter((j) => byOrder(j, job) < 0 && kindOf(j) !== 'done' && kindOf(j) !== 'failed').length;
}

const DEFAULT_DEADLINE_MS = 90000;

export function subLine(job, group, now) {
  if (job.state === 'queued' || (job.state === 'resolving' && !started(job))) {
    return { key: 'queued_behind', params: { n: waitingBefore(job, group) } };
  }
  if (job.state !== 'resolving') return null;
  const r = job.resolve;
  if (job.step === 'page') return { key: 'resolve_opening', params: {} };
  if (job.step === 'video') {
    const max = Math.round((Number(r.deadlineMs) || DEFAULT_DEADLINE_MS) / 1000);
    const sec = Math.min(max, Math.max(0, Math.floor((now - r.startedAt) / 1000)));
    return { key: r.note === 'short_only' ? 'resolve_short_only' : 'resolve_waiting', params: { sec, max } };
  }
  return null;
}

export function summaryLine(group, folded) {
  const parts = [];
  if (!folded) {
    for (const k of ['done', 'active', 'finding', 'failed', 'queued']) {
      if (group.counts[k]) parts.push({ key: 'season_sum_' + k, params: { n: group.counts[k] } });
    }
    return { key: 'season_sum', parts };
  }
  const items = group.jobs.filter((j) => ['active', 'finding', 'failed'].includes(kindOf(j)));
  for (const j of items.slice(0, 3)) {
    const n = epOf(j);
    const k = kindOf(j);
    if (k === 'active') {
      const key = j.state === 'muxing' ? 'ep_sum_muxing' : j.state === 'paused' ? 'ep_sum_paused' : 'ep_sum_downloading';
      parts.push({ key, params: { n, pct: Math.round((j.progress && j.progress.percent) || 0) } });
    } else if (k === 'finding') {
      parts.push({ key: 'ep_sum_finding', params: { n } });
    } else {
      parts.push({ key: 'ep_sum_failed', params: { n } });
    }
  }
  if (items.length > 3) parts.push({ key: 'ep_sum_more', params: { n: items.length - 3 } });
  return { key: 'season_sum', parts };
}

export function dots(group) {
  return group.jobs
    .slice()
    .sort(byOrder)
    .map((j) => {
      const k = kindOf(j);
      return k === 'finding' ? 'active' : k;
    });
}

// Same folder name as the helper's names.js sanitize(), so group.key matches names.folder.
export function folderName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .replace(/^(con|prn|aux|nul|com\d|lpt\d)$/i, '_$1')
    .slice(0, 150) || 'Video';
}

export function seasonKey(name, season) {
  return `${folderName(name)}/S${season}`;
}

// Resolver order: series by name, seasons by number (S2 before S10), then episodes.
export function resolveOrder(a, b) {
  const ka = String((a.group && a.group.key) || '');
  const kb = String((b.group && b.group.key) || '');
  return ka.localeCompare(kb, undefined, { numeric: true }) || byOrder(a, b);
}
