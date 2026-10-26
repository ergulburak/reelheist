// What the bottom status bar says about the queue. Pure: no DOM, no i18n.
// running: jobs downloading or making the MP4 (several with parallel downloads).
// first: the job the bar names (the first running one, else the first waiting one), or null.
// pct: the mean percent of the running jobs (of `first` when none runs).
// waiting: queued jobs that are not `first`.
export function queueSummary(jobs = []) {
  const running = jobs.filter(j => j.state === 'downloading' || j.state === 'muxing');
  const queued = jobs.filter(j => j.state === 'queued');
  const first = running[0] || queued[0] || null;
  const pctOf = j => Number(j.progress?.percent) || 0;
  const shown = running.length ? running : first ? [first] : [];
  const pct = shown.length ? Math.round(shown.reduce((a, j) => a + pctOf(j), 0) / shown.length) : 0;
  return { first, running, pct, waiting: running.length ? queued.length : Math.max(0, queued.length - 1) };
}
