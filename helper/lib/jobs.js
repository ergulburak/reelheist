'use strict';
// Persistent download queue. One job runs at a time.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');
const { buildNames } = require('./names');
const { downloadHls, downloadFile, writeSubtitles } = require('./download');
const { mux, findFfmpeg, probeStreams, checkOutput } = require('./mux');
const ytdlp = require('./ytdlp');
const { toCoded } = require('./errors');

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
  constructor({ log = () => {} } = {}) {
    this.jobs = [];
    this.settings = { outDir: P.DEFAULT_OUT_DIR };
    this.running = null;
    this.log = log;
    this.saveTimer = null;
  }

  async load() {
    await fsp.mkdir(P.DATA_DIR, { recursive: true });
    try { this.jobs = JSON.parse(await fsp.readFile(P.JOBS_FILE, 'utf8')); } catch { this.jobs = []; }
    try { Object.assign(this.settings, JSON.parse(await fsp.readFile(P.SETTINGS_FILE, 'utf8'))); } catch { /* defaults */ }
    // Jobs interrupted by a restart go back to the queue; their segments on disk are reused.
    for (const j of this.jobs) if (j.state === 'downloading' || j.state === 'muxing') j.state = 'queued';
    await this.save();
    this.kick();
  }

  async save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const tmp = P.JOBS_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(this.jobs, null, 1));
    await fsp.rename(tmp, P.JOBS_FILE);
  }

  saveSoon() {
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.save().catch(() => {}), 5000);
      this.saveTimer.unref?.();
    }
  }

  async setSettings(s) {
    if (typeof s.outDir === 'string' && s.outDir.trim()) this.settings.outDir = s.outDir.trim();
    await fsp.writeFile(P.SETTINGS_FILE, JSON.stringify(this.settings, null, 1));
    return this.settings;
  }

  list() {
    return this.jobs.map(j => ({ ...j, source: { kind: j.source.kind, url: j.source.url } }));
  }

  get(id) {
    return this.jobs.find(j => j.id === id);
  }

  async add(input) {
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
    return job;
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
    if (!j || this.running?.job === j) return j;
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
    return j;
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
        const c = toCoded(e);
        next.errorCode = c.code;
        next.error = c.detail;
        next.expired = [401, 403, 404, 410].includes(e.status);
        if (next.expired) next.errorCode = 'link_expired';
        this.log(`İş ${next.id} hata: ${e.stack || e}`);
      })
      .finally(async () => {
        if (this.running === entry) this.running = null;
        await this.save().catch(() => {});
        this.kick();
      });
  }

  async runJob(job, signal) {
    const workDir = path.join(P.WORK_DIR, job.id);
    await fsp.mkdir(workDir, { recursive: true });
    const outDir = path.join(job.outDir || this.settings.outDir, job.names.folder);
    await fsp.mkdir(outDir, { recursive: true });
    job.state = 'downloading';
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

    if (job.source.kind === 'ytdlp') {
      const r = await ytdlp.download(job, workDir, outDir, onProgress, signal, this.log);
      job.state = 'done';
      job.progress = { phase: 'done', percent: 100, bytes: r.size, totalBytes: r.size };
      job.output = { video: r.video, size: r.size, audioTracks: r.audioTracks, subtitles: r.subtitles };
      job.finishedAt = Date.now();
      job.stats = {
        ...r.stats,
        muxMs: null,
        totalMs: job.finishedAt - job.startedAt,
        avgSpeed: r.stats.downloadMs ? Math.round((r.size / r.stats.downloadMs) * 1000) : null,
      };
      await this.cleanWork(job);
      this.log(`İş ${job.id} bitti: ${r.video} | yt-dlp ${Math.round(job.stats.totalMs / 1000)} sn, ` +
        `${Math.round(r.size / 1e6)} MB, ort. ${((job.stats.avgSpeed || 0) / 1e6).toFixed(1)} MB/sn, biçimler ${r.stats.formats}`);
      return;
    }

    const result = job.source.kind === 'file'
      ? await downloadFile(job, workDir, onProgress, signal)
      : await downloadHls(job, workDir, onProgress, signal);

    const seen = new Set();
    const subList = [...job.subtitles, ...result.extraSubs].filter(s => !seen.has(s.url) && seen.add(s.url));
    const writtenSubs = await writeSubtitles(subList, outDir, job.names.base, signal, this.log);

    const videoFile = path.join(outDir, `${job.names.base}.mp4`);
    job.state = 'muxing';
    job.progress = { ...job.progress, phase: 'muxing', percent: 0 };
    await this.save();
    const muxStart = Date.now();
    if (result.direct) {
      await fsp.copyFile(result.streams[0].file, videoFile);
    } else {
      await mux(result.streams, videoFile, { duration: result.duration, onProgress, signal, log: this.log });
    }
    const muxMs = Date.now() - muxStart;
    const st = await fsp.stat(videoFile);
    // A finished file whose audio and video lengths differ has frozen or silent parts.
    const ffmpeg = findFfmpeg();
    const warn = ffmpeg ? checkOutput(await probeStreams(ffmpeg, videoFile), result.duration) : null;
    if (warn) {
      job.warning = warn.code;
      job.warningDetail = warn.detail;
      this.log(`İş ${job.id} uyarı: süreler uyuşmuyor (${warn.detail})`);
    }
    job.state = 'done';
    job.progress = { phase: 'done', percent: 100, bytes: st.size, totalBytes: st.size };
    job.output = {
      video: videoFile,
      size: st.size,
      audioTracks: result.streams.filter(s => s.kind === 'audio').map(s => s.name || s.lang),
      subtitles: writtenSubs,
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
    const sec = ms => `${Math.round((ms || 0) / 1000)} sn`;
    this.log(`İş ${job.id} bitti: ${videoFile} | indirme ${sec(dl.downloadMs)}, ` +
      `${Math.round((dl.bytes || 0) / 1e6)} MB, ort. ${((job.stats.avgSpeed || 0) / 1e6).toFixed(1)} MB/sn, ` +
      `bağlantı en çok ${dl.peakConnections || '-'} / son ${dl.finalConnections || '-'}, yeniden deneme ${dl.retries || 0} | ` +
      `MP4 ${sec(muxMs)} | toplam ${sec(job.stats.totalMs)}`);
  }
}

module.exports = { Queue };
