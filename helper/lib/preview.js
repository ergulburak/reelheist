'use strict';
// 2-second silent preview clip: one HLS segment (or a yt-dlp section) cut with ffmpeg into a tiny MP4.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');
const { request, getText } = require('./http');
const hls = require('./hls');
const { stripToTsSync, isValidSegment, ivForSegment } = require('./download');
const { findFfmpeg, run: runFfmpeg } = require('./mux');
const ytdlp = require('./ytdlp');
const { CodedError } = require('./errors');

const CLIP_SEC = 2;
const FRACTION = 0.3;
const MAX_AGE_MS = 10 * 60 * 1000;
const GENERATE_TIMEOUT_MS = 30000;
const CLEAN_EVERY_MS = 60 * 60 * 1000;

const stats = { ffmpegRuns: 0 };
const jobs = new Map(); // id -> { state: 'pending'|'ready'|'error', file, time, promise, error }

const previewDir = () => path.join(P.DATA_DIR, 'preview');
const keyFor = url => crypto.createHash('sha1').update(String(url)).digest('hex');

// Segment containing `fraction` of the total duration, and the offset inside it.
function pickPreviewSegment(segments, fraction = FRACTION) {
  const total = segments.reduce((t, s) => t + (s.duration || 0), 0);
  const target = total * fraction;
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    const d = segments[i].duration || 0;
    if (target < acc + d || i === segments.length - 1) {
      return { index: i, offsetSec: Math.max(0, Math.round((target - acc) * 1000) / 1000) };
    }
    acc += d;
  }
  return { index: 0, offsetSec: 0 };
}

// opts.inputSeek: seek before -i (a long remote file); opts.headers: HTTP headers for a remote input.
function previewArgs(input, offsetSec, outFile, opts = {}) {
  const args = ['-hide_banner', '-nostdin', '-y'];
  if (/^https?:\/\//i.test(input)) args.push('-rw_timeout', '15000000'); // network stall -> error after 15 s
  if (opts.headers) args.push('-headers', opts.headers);
  // For a lone segment -ss goes after -i: it has one keyframe, so an input seek would find nothing.
  if (opts.inputSeek) args.push('-ss', String(offsetSec), '-i', input);
  else args.push('-i', input, '-ss', String(offsetSec));
  args.push('-t', String(CLIP_SEC), '-an', '-vf', 'scale=320:-2,fps=24',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-movflags', '+faststart', '-f', 'mp4');
  if (outFile) args.push(outFile);
  return args;
}

async function encode(ffmpeg, input, offsetSec, outFile, opts, { signal, runner = runFfmpeg } = {}) {
  stats.ffmpegRuns++;
  const tmp = outFile + '.part';
  await runner(ffmpeg, previewArgs(input, offsetSec, tmp, opts), { signal });
  await fsp.rename(tmp, outFile);
}

// HLS: lowest-bandwidth variant, the segment at 30 %; only that segment is downloaded.
async function hlsSource(url, { headers, playlists }, workBase, signal) {
  const opts = { headers, retries: 2, cache: playlists || null, signal };
  const { text, finalUrl } = await getText(url, opts);
  if (!/^﻿?#EXTM3U/.test(text.trimStart())) throw new CodedError('not_hls', 'The source is not an HLS playlist');
  let mediaText = text;
  let mediaUrl = finalUrl;
  if (hls.isMaster(text)) {
    const variants = hls.parseMaster(text, finalUrl).variants;
    if (!variants.length) throw new CodedError('no_quality', 'No variant in the playlist');
    const low = [...variants].sort((a, b) => (a.bandwidth || Infinity) - (b.bandwidth || Infinity))[0];
    const r = await getText(low.url, opts);
    mediaText = r.text;
    mediaUrl = r.finalUrl;
  }
  const media = hls.parseMedia(mediaText, mediaUrl);
  if (!media.segments.length) throw new CodedError('playlist_empty', 'The media playlist has no segments');
  if (media.segments.some(s => s.key && s.key.method !== 'AES-128')) throw new CodedError('drm', 'Stream is encrypted (DRM)');
  const { index, offsetSec } = pickPreviewSegment(media.segments);
  const seg = media.segments[index];
  const fmp4 = !!seg.map;
  let { buf, res } = await request(seg.url, { signal, headers, range: seg.range, retries: 2 });
  if (seg.key) {
    const key = (await request(seg.key.url, { signal, headers, retries: 2 })).buf;
    const d = crypto.createDecipheriv('aes-128-cbc', key, ivForSegment(seg.key, seg.seq));
    buf = Buffer.concat([d.update(buf), d.final()]);
  }
  if (!fmp4) buf = stripToTsSync(buf);
  if (!isValidSegment(buf, fmp4, res.headers.get('content-type') || '')) {
    throw new CodedError('bad_segment', `Invalid segment (${buf.length} bytes)`);
  }
  if (fmp4) {
    const init = await request(seg.map.url, { signal, headers, range: seg.map.range, retries: 2 });
    buf = Buffer.concat([init.buf, buf]);
  }
  const file = `${workBase}-seg.${fmp4 ? 'mp4' : 'ts'}`;
  await fsp.writeFile(file, buf);
  // Keep the whole clip inside the segment when it is long enough.
  const offset = seg.duration > CLIP_SEC ? Math.min(offsetSec, seg.duration - CLIP_SEC) : 0;
  return { file, offsetSec: offset };
}

// YouTube: smallest video-only format, only a 2 s section starting at 30 % of the duration.
// Fast path: ffmpeg reads the section straight from the format URL (about 2 s). yt-dlp
// "--download-sections" does the same job but needs 6 s or more, so it is the fallback.
async function ytPlan(url, signal) {
  const json = await ytdlp.probeRaw(url, { signal });
  if (json.is_live) throw new CodedError('live', 'Live streams have no preview');
  const vids = (json.formats || []).filter(f => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none'));
  if (!vids.length || !json.duration) throw new CodedError('no_video', 'No video format for the preview');
  vids.sort((a, b) => (a.tbr || a.filesize || Infinity) - (b.tbr || b.filesize || Infinity));
  const fast = vids.find(f => f.protocol === 'https' && f.url);
  const t = Math.floor(json.duration * FRACTION);
  return { json, format: vids[0], fast, t };
}

async function ytSection(plan, url, workBase, signal) {
  const infoFile = `${workBase}-info.json`;
  await fsp.writeFile(infoFile, JSON.stringify(plan.json));
  try {
    const exe = await ytdlp.ensureYtdlp();
    // --load-info-json reuses the probe result (no second extraction).
    await ytdlp.run(exe, [...ytdlp.baseArgs(), '--no-warnings', '--load-info-json', infoFile, '-f', plan.format.format_id,
      '--download-sections', `*${plan.t}-${plan.t + CLIP_SEC}`, '-o', `${workBase}-src.%(ext)s`], { signal });
  } finally {
    fsp.rm(infoFile, { force: true }).catch(() => {});
  }
  const prefix = `${path.basename(workBase)}-src.`;
  const found = (await fsp.readdir(path.dirname(workBase))).find(f => f.startsWith(prefix) && !f.endsWith('.part'));
  if (!found) throw new CodedError('ytdlp_failed', 'yt-dlp wrote no preview file');
  return { file: path.join(path.dirname(workBase), found), offsetSec: 0 };
}

async function generate(source, { kind, playlists, headers, timeoutMs = GENERATE_TIMEOUT_MS, runner }, file) {
  // One deadline for the whole job: the runners kill their child process on abort.
  const signal = AbortSignal.timeout(timeoutMs);
  const ctx = { signal, runner };
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new CodedError('ffmpeg_missing', 'ffmpeg was not found');
  const workBase = file.replace(/.mp4$/, '');
  let src;
  try {
    if (kind === 'ytdlp') {
      const plan = await ytPlan(source, signal);
      let done = false;
      if (plan.fast) {
        const hd = Object.entries(plan.fast.http_headers || plan.json.http_headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
        try {
          await encode(ffmpeg, plan.fast.url, plan.t, file, { inputSeek: true, headers: hd || undefined }, ctx);
          done = true;
        } catch { /* fall back to yt-dlp */ }
      }
      if (!done) {
        src = await ytSection(plan, source, workBase, signal);
        await encode(ffmpeg, src.file, 0, file, undefined, ctx);
      }
    } else {
      src = await hlsSource(source, { headers, playlists }, workBase, signal);
      await encode(ffmpeg, src.file, src.offsetSec, file, undefined, ctx);
    }
  } finally {
    if (src) fsp.rm(src.file, { force: true }).catch(() => {});
    fsp.rm(file + '.part', { force: true }).catch(() => {});
  }
}

// Start (or join) the job for this source. Returns { id, file }; poll with previewStatus.
function startPreview(source, opts = {}) {
  const id = keyFor(source);
  const file = path.join(previewDir(), `${id}.mp4`);
  const job = jobs.get(id);
  if (job && (job.state === 'pending' || (job.state === 'ready' && Date.now() - job.time < MAX_AGE_MS))) return { id, file };
  const entry = { state: 'pending', file, time: Date.now(), error: null, promise: null };
  entry.promise = (async () => {
    await fsp.mkdir(previewDir(), { recursive: true });
    try {
      const st = await fsp.stat(file);
      if (Date.now() - st.mtimeMs < MAX_AGE_MS) { entry.time = st.mtimeMs; return; } // cache from an earlier run
    } catch { /* no cached file */ }
    await generate(source, opts, file);
    entry.time = Date.now();
  })().then(() => { entry.state = 'ready'; }, e => { entry.state = 'error'; entry.error = e; });
  jobs.set(id, entry);
  return { id, file };
}

async function makePreview(source, opts = {}) {
  const { id, file } = startPreview(source, opts);
  const job = jobs.get(id);
  await job.promise;
  if (job.state === 'error') throw job.error;
  return { id, file };
}

// -> { state: 'ready', file } | { state: 'pending' } | { state: 'error', error } | { state: 'none' }
async function previewStatus(id) {
  const job = jobs.get(id);
  if (job && !(job.state === 'ready' && Date.now() - job.time >= MAX_AGE_MS)) {
    return { state: job.state, file: job.file, error: job.error };
  }
  if (!/^[0-9a-f]{40}$/.test(id)) return { state: 'none' };
  const file = path.join(previewDir(), `${id}.mp4`);
  try {
    const st = await fsp.stat(file);
    if (Date.now() - st.mtimeMs < MAX_AGE_MS) return { state: 'ready', file };
  } catch { /* none */ }
  return { state: 'none' };
}

// Delete preview files older than the cache time.
async function cleanOld(maxAgeMs = MAX_AGE_MS) {
  let names;
  try { names = await fsp.readdir(previewDir()); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const f = path.join(previewDir(), name);
    try {
      const st = await fsp.stat(f);
      if (Date.now() - st.mtimeMs >= maxAgeMs) { await fsp.rm(f, { force: true }); n++; }
    } catch { /* already gone */ }
  }
  return n;
}

function startCleaner() {
  cleanOld().catch(() => {});
  const timer = setInterval(() => cleanOld().catch(() => {}), CLEAN_EVERY_MS);
  timer.unref();
  return timer;
}

module.exports = {
  pickPreviewSegment, previewArgs, makePreview, startPreview, previewStatus, cleanOld, startCleaner, keyFor, stats, MAX_AGE_MS,
};
