'use strict';
// Persistent download queue. One job runs at a time.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');
const { buildNames, SRT_DIR } = require('./names');
const { downloadHls, downloadFile, writeSubtitles, planHlsSubtitles } = require('./download');
const { mux, findFfmpeg, probeStreams, checkOutput, embedSubtitles } = require('./mux');
const ytdlp = require('./ytdlp');
const { toCoded, CodedError, CODES } = require('./errors');
const notify = require('./notify');

const NOTIFY_MODES = ['all', 'errors', 'off'];
const RESOLVE_STEPS = ['page', 'video'];
const DEFAULT_DEADLINE_MS = 90000;
const ACTIVE = ['resolving', 'queued', 'downloading', 'muxing', 'paused', 'failed'];

// embedSubs from the extension: { lang } (the language that turns on by itself, may be '') or null.
function cleanEmbed(e) {
  if (!e || typeof e !== 'object') return null;
  // keepSrt: keep the .srt files (in SRT_DIR) after they went into the MP4; only false turns it off.
  return { lang: typeof e.lang === 'string' ? e.lang.slice(0, 16) : '', keepSrt: e.keepSrt !== false };
}

// Keep only string playlists, at most ~2 MB in total.
function cleanPlaylists(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  let size = 0;
  for (const [k, v] of Object.entries(p)) {
    if (typeof v !== 'string' || !v.startsWith('#EXTM3U')) continue;
    size += v.length;
    if (size > 2e6) break;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

class Queue {
  constructor({ log = () => {}, notify: notifier } = {}) {
    this.jobs = [];
    this.settings = { outDir: P.DEFAULT_OUT_DIR, notify: 'all', lang: 'en' };
    this.notifier = notifier || (n => notify.send(n, this.log));
    this.running = null;
    this.log = log;
    this.saveTimer = null;
    this.watchdog = null;
  }

  async load() {
    await fsp.mkdir(P.DATA_DIR, { recursive: true });
    try { this.jobs = JSON.parse(await fsp.readFile(P.JOBS_FILE, 'utf8')); } catch { this.jobs = []; }
    try { Object.assign(this.settings, JSON.parse(await fsp.readFile(P.SETTINGS_FILE, 'utf8'))); } catch { /* defaults */ }
    // Jobs interrupted by a restart go back to the queue; their segments on disk are reused.
    for (const j of this.jobs) if (j.state === 'downloading' || j.state === 'muxing') j.state = 'queued';
    // A resolver that had started cannot survive a restart; one that never started stays waiting.
    const interrupted = this.jobs.filter(j => j.state === 'resolving' && j.resolve?.startedAt != null);
    for (const j of interrupted) this.failJob(j, 'episode_interrupted', 'Resolver stopped', 'video');
    await this.save();
    for (const j of interrupted) this.onFailed(j);
    this.kick();
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => this.tickWatchdog(), 15000);
    this.watchdog.unref();
  }

  // Saves run one after another: two at once (cancel + the job's own finally) would race on
  // the temp file and the rename would fail with ENOENT.
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const write = () => this.writeJobs();
    this.saving = (this.saving || Promise.resolve()).then(write, write);
    return this.saving;
  }

  async writeJobs() {
    const tmp = `${P.JOBS_FILE}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.jobs, null, 1));
    // Windows refuses the rename while another process (virus scanner, a reader) holds the
    // file open; that passes in a moment.
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(tmp, P.JOBS_FILE);
        return;
      } catch (e) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
          await fsp.rm(tmp, { force: true }).catch(() => {});
          throw e;
        }
        await new Promise(r => setTimeout(r, 40 * (attempt + 1)));
      }
    }
  }

  saveSoon() {
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.save().catch(() => {}), 5000);
      this.saveTimer.unref?.();
    }
  }

  async setSettings(s) {
    if (typeof s.outDir === 'string' && s.outDir.trim()) this.settings.outDir = s.outDir.trim();
    if (NOTIFY_MODES.includes(s.notify)) this.settings.notify = s.notify;
    if (typeof s.lang === 'string' && /^[A-Za-z_]{2,10}$/.test(s.lang)) this.settings.lang = s.lang;
    await fsp.writeFile(P.SETTINGS_FILE, JSON.stringify(this.settings, null, 1));
    return this.settings;
  }

  notifyMode() {
    return NOTIFY_MODES.includes(this.settings.notify) ? this.settings.notify : 'all';
  }

  // Fire and forget: a toast never delays or fails a job.
  toast(key, vars) {
    try {
      const body = notify.fill(notify.texts(this.settings.lang)[key], vars);
      Promise.resolve(this.notifier({ key, vars, title: 'ReelHeist', body })).catch(e => this.log(`Bildirim hatası: ${e.message}`));
    } catch (e) {
      this.log(`Bildirim hatası: ${e.message}`);
    }
  }

  // A job just reached 'done'.
  onDone(job) {
    if (this.notifyMode() !== 'all') return;
    const subs = job.output?.subtitles?.length || 0;
    const key = job.subtitlesOnly ? 'notify_done_subs_only'
      : job.warning === 'av_mismatch' ? 'notify_done_warn' : subs ? 'notify_done_subs' : 'notify_done';
    this.toast(key, { name: job.names?.base, size: notify.formatSize(job.output?.size), n: subs });
    const g = job.group;
    if (!g) return;
    const mates = this.jobs.filter(j => j.group?.key === g.key);
    if (mates.some(j => ACTIVE.includes(j.state))) return;
    this.toast('notify_season_done', { name: g.name, season: g.season, n: mates.filter(j => j.state === 'done').length });
  }

  // A job just reached 'failed'.
  onFailed(job) {
    if (this.notifyMode() === 'off') return;
    const error = notify.errorText(this.settings.lang, job.errorCode) || job.error || '';
    this.toast('notify_failed', { name: job.names?.base, error });
  }

  // The popup polls this every second: no headers, no cached playlists (they can be megabytes).
  list() {
    return this.jobs.map(j => ({ ...j, playlists: undefined, source: { kind: j.source.kind, url: j.source.url } }));
  }

  get(id) {
    return this.jobs.find(j => j.id === id);
  }

  async add(input) {
    if (input?.state === 'resolving') return this.addResolving(input);
    if (!input?.source?.url) throw new Error('source.url is required');
    if (!input.meta?.name) throw new Error('meta.name is required');
    // Login cookies go to a file yt-dlp reads, never into jobs.json.
    if (input.cookies) await ytdlp.saveCookies(input.cookies);
    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      createdAt: Date.now(),
      state: 'queued',
      error: null,
      errorCode: null,
      meta: input.meta,
      pageUrl: input.pageUrl || null,
      source: { kind: input.source.kind || 'hls', url: input.source.url, headers: input.source.headers || {} },
      quality: input.quality || null,
      audio: input.audio || 'all',
      subtitles: (input.subtitles || []).map(s => ({
        url: s.url, lang: s.lang || '', label: s.label || '', headers: s.headers || {}, hls: !!s.hls,
      })),
      includeHlsSubtitles: input.includeHlsSubtitles !== false,
      subtitlesOnly: !!input.subtitlesOnly,
      embedSubs: cleanEmbed(input.embedSubs),
      playlists: cleanPlaylists(input.playlists),
      maxSegments: input.maxSegments || null,
      outDir: input.outDir || null,
      names: buildNames(input.meta),
      progress: null,
      output: null,
    };
    // Same output already waiting? Replace it instead of downloading twice.
    const dup = this.jobs.find(j => j.state === 'queued' && j.names.folder === job.names.folder && j.names.base === job.names.base);
    if (dup) this.jobs.splice(this.jobs.indexOf(dup), 1);
    this.jobs.push(job);
    await this.save();
    this.kick();
    return { job, reused: false, skipped: false };
  }

  // A season episode exists as a job before its video URL is known.
  async addResolving(input) {
    if (!input.pageUrl) throw new Error('pageUrl is required');
    if (!input.meta?.name) throw new Error('meta.name is required');
    const dup = this.jobs.find(j => j.pageUrl === input.pageUrl);
    if (dup) {
      if (dup.state === 'done') return { job: dup, reused: false, skipped: true };
      if (dup.state === 'failed' || dup.state === 'canceled') await this.retryResolve(dup.id);
      return { job: dup, reused: true, skipped: false };
    }
    const g = input.group || {};
    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      createdAt: Date.now(),
      state: 'resolving',
      step: 'page',
      stepError: null,
      error: null,
      errorCode: null,
      meta: input.meta,
      pageUrl: input.pageUrl,
      group: { key: g.key, name: g.name, season: g.season, count: g.count },
      resolve: { attempts: 0, startedAt: null, deadlineMs: null, note: null },
      source: { kind: null, url: null, headers: {} },
      quality: input.quality || null,
      audio: input.audio || 'all',
      subtitles: [],
      includeHlsSubtitles: input.includeHlsSubtitles !== false,
      subtitlesOnly: !!input.subtitlesOnly,
      embedSubs: cleanEmbed(input.embedSubs),
      playlists: null,
      maxSegments: input.maxSegments || null,
      outDir: input.outDir || null,
      names: buildNames(input.meta),
      progress: null,
      output: null,
    };
    this.jobs.push(job);
    await this.save();
    return { job, reused: false, skipped: false };
  }

  // Resolver calls only make sense while the job is still resolving.
  resolvingJob(id) {
    const j = this.get(id);
    if (!j || j.state !== 'resolving') throw new CodedError('state', `Job is not resolving (${j ? j.state : 'missing'})`);
    return j;
  }

  async resolveUpdate(id, patch = {}) {
    const j = this.resolvingJob(id);
    if (patch.step !== undefined && !RESOLVE_STEPS.includes(patch.step)) {
      throw new CodedError('bad_request', `Unknown resolve step ${patch.step}`);
    }
    if (patch.note === 'resume' && this.notifyMode() !== 'off') {
      const n = Number.isFinite(patch.remaining) ? patch.remaining
        : this.jobs.filter(x => x.state === 'resolving' && x.resolve?.startedAt == null).length;
      this.toast('notify_resume', { n });
    }
    if (patch.step) j.step = patch.step;
    for (const k of ['note', 'attempts', 'deadlineMs', 'startedAt', 'heartbeat']) {
      if (patch[k] !== undefined) j.resolve[k] = patch[k];
    }
    await this.save();
    return j;
  }

  // body.meta is ignored: the names were fixed when the card was made (spec decision 4).
  async resolved(id, { source, playlists, subtitles } = {}) {
    const j = this.resolvingJob(id);
    if (typeof source?.url !== 'string' || !source.url) throw new CodedError('bad_request', 'source.url is required');
    j.source = { kind: source.kind || 'hls', url: source.url, headers: source.headers || {} };
    j.playlists = cleanPlaylists(playlists);
    j.subtitles = (subtitles || []).map(s => ({
      url: s.url, lang: s.lang || '', label: s.label || '', headers: s.headers || {}, hls: !!s.hls,
    }));
    j.state = 'queued';
    j.step = 'download';
    await this.save();
    this.kick();
    return j;
  }

  failJob(j, code, detail, step) {
    j.state = 'failed';
    j.stepError = step;
    j.errorCode = CODES.includes(code) ? code : 'internal';
    j.error = detail;
  }

  async fail(id, { code, detail, step } = {}) {
    const j = this.resolvingJob(id);
    // The resolver fails at the page or at the video; anything else counts as the video step.
    this.failJob(j, code, detail, RESOLVE_STEPS.includes(step) ? step : 'video');
    await this.save();
    this.onFailed(j);
    return j;
  }

  async retryResolve(id) {
    const j = this.get(id);
    if (!j) throw new CodedError('bad_request', `Unknown job ${id}`);
    // A canceled job can still be stopping: let it end before its work folder is removed.
    if (this.running?.job === j) await this.running.done?.catch(() => {});
    j.state = 'resolving';
    j.step = 'page';
    j.stepError = null;
    j.error = null;
    j.errorCode = null;
    // A new search finds new URLs: nothing of an earlier download is kept.
    j.expired = false;
    j.progress = null;
    j.output = null;
    j.warning = null;
    j.warningDetail = null;
    j.stats = null;
    j.resolve = { attempts: 0, startedAt: null, deadlineMs: null, note: null };
    await this.cleanWork(j);
    await this.save();
    return j;
  }

  // Fails resolving jobs whose resolver went silent past its deadline.
  // A heartbeat from the resolver moves the start of the window forward.
  tickWatchdog(now = Date.now()) {
    const stale = [];
    for (const j of this.jobs) {
      const r = j.resolve;
      if (j.state !== 'resolving' || r?.startedAt == null) continue;
      const from = Math.max(r.startedAt, r.heartbeat || 0);
      if (now > from + (r.deadlineMs ?? DEFAULT_DEADLINE_MS) + 60000) {
        this.failJob(j, 'episode_interrupted', 'Resolver stopped', 'video');
        stale.push(j);
      }
    }
    if (stale.length) this.save().catch(() => {});
    for (const j of stale) this.onFailed(j);
    return stale.length;
  }

  async pause(id) {
    const j = this.get(id);
    if (!j) return null;
    const inflight = this.running?.job === j ? this.running.done : null;
    if (['queued', 'downloading', 'muxing'].includes(j.state)) j.state = 'paused';
    if (this.running?.job === j) this.running.ctrl.abort(new Error('paused'));
    if (inflight) await inflight.catch(() => {});
    await this.save();
    return j;
  }

  async cancel(id) {
    const j = this.get(id);
    if (!j) return;
    const inflight = this.running?.job === j ? this.running.done : null;
    if (!['done'].includes(j.state)) j.state = 'canceled';
    if (this.running?.job === j) this.running.ctrl.abort(new Error('canceled'));
    if (inflight) await inflight.catch(() => {});
    await this.save();
    await this.cleanWork(j);
  }

  async retry(id, refresh) {
    const j = this.get(id);
    if (!j || this.running?.job === j) return { job: j, resolve: false };
    // An attempt is already running: leave it alone.
    if (j.state === 'resolving') return { job: j, resolve: true };
    // No source yet (failed resolving, or canceled before resolved): resolve again.
    if ((j.state === 'failed' && ['page', 'video'].includes(j.stepError)) || (!j.source?.url && j.pageUrl)) {
      return { job: await this.retryResolve(id), resolve: true };
    }
    const wasPaused = j.state === 'paused' && !refresh?.source?.url;
    if (refresh?.source?.url) {
      j.source = { ...j.source, ...refresh.source };
      j.playlists = cleanPlaylists(refresh.playlists);
      // New URLs mean new segments: drop what was downloaded with the old ones.
      await this.cleanWork(j);
    }
    if (Array.isArray(refresh?.subtitles) && refresh.subtitles.length) j.subtitles = refresh.subtitles;
    j.state = 'queued';
    j.error = null;
    j.errorCode = null;
    j.expired = false;
    if (!wasPaused) j.progress = null;
    await this.save();
    this.kick();
    return { job: j, resolve: false };
  }

  async remove(id) {
    const j = this.get(id);
    if (!j) return;
    const inflight = this.running?.job === j ? this.running.done : null;
    this.jobs = this.jobs.filter(x => x !== j);
    if (this.running?.job === j) this.running.ctrl.abort(new Error('canceled'));
    if (inflight) await inflight.catch(() => {});
    await this.save();
    await this.cleanWork(j);
  }

  async cleanWork(j) {
    await fsp.rm(path.join(P.WORK_DIR, j.id), { recursive: true, force: true }).catch(() => {});
  }

  kick() {
    if (this.running) return;
    const next = this.jobs.find(j => j.state === 'queued');
    if (!next) return;
    const ctrl = new AbortController();
    const entry = { job: next, ctrl, done: null };
    this.running = entry;
    entry.done = this.runJob(next, ctrl.signal)
      .catch(e => {
        if (ctrl.signal.aborted) return;
        next.state = 'failed';
        next.stepError = next.step || null;
        const c = toCoded(e);
        next.errorCode = c.code;
        next.error = c.detail;
        next.expired = [401, 403, 404, 410].includes(e.status);
        if (next.expired) next.errorCode = 'link_expired';
        this.log(`İş ${next.id} hata: ${e.stack || e}`);
        this.onFailed(next);
      })
      .finally(async () => {
        if (this.running === entry) this.running = null;
        await this.save().catch(() => {});
        this.kick();
      });
  }

  // The settings ask for the subtitles inside the MP4 as well (the .srt files stay).
  // Never fails the job: on an error the MP4 stays as it was. Returns {n, error}.
  async embedSubs(job, videoFile, subs, signal) {
    if (!job.embedSubs || !subs?.length) return { n: 0, error: null };
    try {
      const n = await embedSubtitles(videoFile, subs, { defaultLang: job.embedSubs.lang, uiLang: this.settings.lang, signal });
      return { n, error: null };
    } catch (e) {
      if (signal?.aborted) throw e;
      this.log(`İş ${job.id}: altyazılar MP4'e eklenemedi: ${e.message}`);
      return { n: 0, error: e.message };
    }
  }

  // Where the job writes its files: the series/movie folder, plus the episode's own folder.
  jobDir(job) {
    return path.join(job.outDir || this.settings.outDir, job.names.folder, job.names.sub || '');
  }

  // The .srt files go away only when the settings say so and every one of them is inside the MP4.
  // Returns true when the files stay.
  async finishSrt(job, subs, embed) {
    if (!subs?.length || job.embedSubs?.keepSrt !== false || !embed.n || embed.error) return true;
    for (const s of subs) await fsp.rm(s.file, { force: true }).catch(() => {});
    const dir = path.dirname(subs[0].file);
    if (path.basename(dir) === SRT_DIR) await fsp.rmdir(dir).catch(() => {}); // only when empty
    return false;
  }

  async runJob(job, signal) {
    const workDir = path.join(P.WORK_DIR, job.id);
    await fsp.mkdir(workDir, { recursive: true });
    const outDir = this.jobDir(job);
    await fsp.mkdir(outDir, { recursive: true });
    job.state = 'downloading';
    job.step = 'download';
    job.stepError = null;
    job.error = null;
    job.errorCode = null;
    job.startedAt = Date.now();
    job.stats = null;
    job.warning = null;
    job.warningDetail = null;
    job.progress = { phase: 'downloading', percent: 0 };
    await this.save();
    const onProgress = p => {
      job.progress = { ...job.progress, ...p };
      this.saveSoon();
    };
    this.log(`İş ${job.id} başladı: ${job.names.base}`);

    if (job.subtitlesOnly) {
      let written;
      if (job.source.kind === 'ytdlp') {
        written = (await ytdlp.downloadSubtitles(job, workDir, outDir, signal, this.log)).subtitles;
      } else {
        const extra = job.source.kind === 'hls' ? await planHlsSubtitles(job, signal).catch(() => []) : [];
        const seen = new Set();
        const list = [...job.subtitles, ...extra].filter(s => !seen.has(s.url) && seen.add(s.url));
        written = await writeSubtitles(list, path.join(outDir, SRT_DIR), job.names.base, signal, this.log);
      }
      if (!written.length) throw new CodedError('no_subtitles', 'No subtitle could be downloaded from this page');
      job.state = 'done';
      job.step = 'done';
      job.progress = { phase: 'done', percent: 100, bytes: 0, totalBytes: 0 };
      job.output = { video: null, size: 0, audioTracks: [], subtitles: written };
      job.finishedAt = Date.now();
      job.stats = { downloadMs: job.finishedAt - job.startedAt, bytes: 0, retries: 0, muxMs: null, totalMs: job.finishedAt - job.startedAt, avgSpeed: null };
      await this.cleanWork(job);
      this.onDone(job);
      this.log(`İş ${job.id} bitti: ${written.length} altyazı (${written.map(s => s.lang).join(', ')})`);
      return;
    }

    if (job.source.kind === 'ytdlp') {
      const r = await ytdlp.download(job, workDir, outDir, onProgress, signal, this.log);
      const embed = await this.embedSubs(job, r.video, r.subtitles, signal);
      if (embed.error) {
        job.warning = 'subs_not_embedded';
        job.warningDetail = embed.error;
      }
      if (embed.n) r.size = (await fsp.stat(r.video)).size;
      const srtKept = await this.finishSrt(job, r.subtitles, embed);
      job.state = 'done';
      job.step = 'done';
      job.progress = { phase: 'done', percent: 100, bytes: r.size, totalBytes: r.size };
      job.output = { video: r.video, size: r.size, audioTracks: r.audioTracks, subtitles: r.subtitles, embeddedSubs: embed.n, srtKept };
      job.finishedAt = Date.now();
      job.stats = {
        ...r.stats,
        muxMs: null,
        totalMs: job.finishedAt - job.startedAt,
        avgSpeed: r.stats.downloadMs ? Math.round((r.size / r.stats.downloadMs) * 1000) : null,
      };
      await this.cleanWork(job);
      this.onDone(job);
      this.log(`İş ${job.id} bitti: ${r.video} | yt-dlp ${Math.round(job.stats.totalMs / 1000)} sn, ` +
        `${Math.round(r.size / 1e6)} MB, ort. ${((job.stats.avgSpeed || 0) / 1e6).toFixed(1)} MB/sn, biçimler ${r.stats.formats}`);
      return;
    }

    const result = job.source.kind === 'file'
      ? await downloadFile(job, workDir, onProgress, signal)
      : await downloadHls(job, workDir, onProgress, signal);

    const seen = new Set();
    const subList = [...job.subtitles, ...result.extraSubs].filter(s => !seen.has(s.url) && seen.add(s.url));
    const writtenSubs = await writeSubtitles(subList, path.join(outDir, SRT_DIR), job.names.base, signal, this.log);

    const videoFile = path.join(outDir, `${job.names.base}.mp4`);
    job.state = 'muxing';
    job.step = 'mux';
    job.progress = { ...job.progress, phase: 'muxing', percent: 0 };
    await this.save();
    const muxStart = Date.now();
    if (result.direct) {
      await fsp.copyFile(result.streams[0].file, videoFile);
    } else {
      await mux(result.streams, videoFile, { duration: result.duration, onProgress, signal, log: this.log });
    }
    const embed = await this.embedSubs(job, videoFile, writtenSubs, signal);
    const srtKept = await this.finishSrt(job, writtenSubs, embed);
    const muxMs = Date.now() - muxStart;
    const st = await fsp.stat(videoFile);
    // A finished file whose audio and video lengths differ has frozen or silent parts.
    const ffmpeg = findFfmpeg();
    const warn = ffmpeg ? checkOutput(await probeStreams(videoFile), result.duration) : null;
    if (warn) {
      job.warning = warn.code;
      job.warningDetail = warn.detail;
      this.log(`İş ${job.id} uyarı: süreler uyuşmuyor (${warn.detail})`);
    } else if (embed.error) {
      job.warning = 'subs_not_embedded';
      job.warningDetail = embed.error;
    }
    job.state = 'done';
    job.step = 'done';
    job.progress = { phase: 'done', percent: 100, bytes: st.size, totalBytes: st.size };
    job.output = {
      video: videoFile,
      size: st.size,
      audioTracks: result.streams.filter(s => s.kind === 'audio').map(s => s.name || s.lang),
      subtitles: writtenSubs,
      embeddedSubs: embed.n,
      srtKept,
    };
    job.finishedAt = Date.now();
    const dl = result.stats || {};
    job.stats = {
      ...dl,
      muxMs,
      totalMs: job.finishedAt - (job.startedAt || job.finishedAt),
      avgSpeed: dl.downloadMs ? Math.round((dl.bytes / dl.downloadMs) * 1000) : null,
    };
    await this.cleanWork(job);
    this.onDone(job);
    const sec = ms => `${Math.round((ms || 0) / 1000)} sn`;
    this.log(`İş ${job.id} bitti: ${videoFile} | indirme ${sec(dl.downloadMs)}, ` +
      `${Math.round((dl.bytes || 0) / 1e6)} MB, ort. ${((job.stats.avgSpeed || 0) / 1e6).toFixed(1)} MB/sn, ` +
      `bağlantı en çok ${dl.peakConnections || '-'} / son ${dl.finalConnections || '-'}, yeniden deneme ${dl.retries || 0} | ` +
      `MP4 ${sec(muxMs)} | toplam ${sec(job.stats.totalMs)}`);
  }
}

module.exports = { Queue };
