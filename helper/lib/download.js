'use strict';
// Download one job: HLS streams (video + audio renditions) or a direct file, plus subtitles.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { request, getText } = require('./http');
const hls = require('./hls');
const { pickVariant } = require('./probe');
const subs = require('./subtitles');
const { subtitleSuffixes, guessLang, isForcedSubtitle } = require('./names');
const { CodedError } = require('./errors');
const { AdaptiveLimiter } = require('./throttle');

const SEGMENT_ATTEMPTS = 6;

// Some hosts disguise TS segments as images; cut everything before the first TS sync run.
function stripToTsSync(buf) {
  if (buf.length > 376 && buf[0] === 0x47 && buf[188] === 0x47) return buf;
  const limit = Math.min(buf.length - 376, 65536);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) return i ? buf.subarray(i) : buf;
  }
  return buf;
}

function ivForSegment(key, seq) {
  if (key.iv) return Buffer.from(key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(seq >>> 0, 12);
  return iv;
}

const FMP4_BOXES = new Set(['moof', 'styp', 'sidx', 'ftyp', 'emsg', 'prft', 'moov', 'free']);

// A rate-limited server may answer 200 with an HTML page or a tiny placeholder.
// Accept only real media: MPEG-TS, packed audio (ID3/ADTS) or fMP4 boxes.
function isValidSegment(buf, fmp4, contentType = '') {
  if (!buf.length) return false;
  if (/text\/html|application\/json/i.test(contentType)) return false;
  if (fmp4) return buf.length >= 8 && FMP4_BOXES.has(buf.toString('latin1', 4, 8));
  if (buf[0] === 0x47 && (buf.length < 376 || buf[188] === 0x47)) return true;
  if (buf.toString('latin1', 0, 3) === 'ID3') return true;
  if (buf[0] === 0xff && (buf[1] & 0xf0) === 0xf0) return true;
  return false;
}

class InvalidSegment extends CodedError {
  constructor(detail) { super('bad_segment', detail); }
}

// Worker pool whose size follows the adaptive limiter.
async function runAdaptive(items, limiter, worker, signal) {
  let next = 0;
  let failed = null;
  const runners = Array.from({ length: Math.min(limiter.max, items.length) }, async () => {
    while (next < items.length && !failed) {
      await limiter.acquire(signal);
      const i = next++;
      if (i >= items.length) { limiter.release(); break; }
      try {
        await worker(items[i]);
      } catch (e) {
        failed = failed || e;
      } finally {
        limiter.release();
      }
    }
  });
  await Promise.all(runners);
  if (failed) throw failed;
}

// Segment indexes grouped by discontinuity: timestamps restart at the start of every group.
function discontinuityGroups(segments) {
  const groups = [];
  let disc = null;
  segments.forEach((seg, i) => {
    if (seg.disc !== disc) { disc = seg.disc; groups.push([]); }
    groups[groups.length - 1].push(i);
  });
  return groups;
}

// No joined copy on disk: ffmpeg reads the segments in order through "concatf:".
// Across a discontinuity the timestamps jump, which "-c copy" would keep (frozen picture,
// audio out of sync): every group gets its own concatf list and the concat demuxer joins the
// groups with continuous timestamps.
async function writeConcatInputs(s, si, workDir) {
  // ffmpeg reads backslash paths in the list as invalid data: use file: + forward slashes.
  const fwd = p => p.replace(/\\/g, '/');
  const segFile = i => path.join(s.dir, `${String(i).padStart(6, '0')}.seg`);
  const lists = [];
  for (const idx of discontinuityGroups(s.segments)) {
    const parts = [];
    const init = s.segments[idx[0]].initFile;
    if (init) parts.push(init);
    for (const i of idx) parts.push(segFile(i));
    const list = path.join(workDir, `stream${si}_${lists.length}.txt`);
    await fsp.writeFile(list, parts.map(p => `file:${fwd(p)}`).join('\n') + '\n');
    lists.push(`concatf:${fwd(list)}`);
  }
  if (lists.length === 1) {
    s.file = lists[0];
    s.concat = false;
    return;
  }
  const list = path.join(workDir, `stream${si}.concat.txt`);
  await fsp.writeFile(list, lists.map(u => `file '${u.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  s.file = list;
  s.concat = true;
}

// Subtitle renditions of an HLS master (subtitle-only jobs read nothing else).
async function planHlsSubtitles(job, signal) {
  if (job.includeHlsSubtitles === false) return [];
  const headers = job.source.headers;
  const { text, finalUrl } = await getText(job.source.url, { headers, signal, cache: job.playlists || null });
  if (!hls.isMaster(text)) return [];
  return hls.parseMaster(text, finalUrl).subtitles.map(s => ({ hls: true, url: s.url, lang: s.lang, label: s.name, forced: s.forced, headers }));
}

// Build the list of streams to fetch for an HLS job.
async function planHls(job, signal) {
  const headers = job.source.headers;
  const cache = job.playlists || null;
  const { text, finalUrl } = await getText(job.source.url, { headers, signal, cache });
  const streams = [];
  const extraSubs = [];
  if (hls.isMaster(text)) {
    const master = hls.parseMaster(text, finalUrl);
    const variant = pickVariant(master.variants, job.quality?.height || null);
    if (!variant) throw new CodedError('no_quality', 'No matching quality in the playlist');
    streams.push({ kind: 'video', url: variant.url, height: variant.height });
    const group = variant.audioGroup;
    const audios = master.audios.filter(a => a.url && (!group || a.groupId === group));
    const chosen = job.audio && job.audio !== 'all'
      ? audios.filter(a => job.audio.includes(a.name))
      : audios;
    for (const a of chosen) {
      streams.push({ kind: 'audio', url: a.url, lang: a.lang, name: a.name, isDefault: a.isDefault });
    }
    if (job.includeHlsSubtitles !== false) {
      const sg = variant.subtitleGroup;
      for (const s of master.subtitles) {
        if (!sg || s.groupId === sg) extraSubs.push({ hls: true, url: s.url, lang: s.lang, label: s.name, headers });
      }
    }
  } else {
    streams.push({ kind: 'video', url: finalUrl, height: null });
  }
  for (const s of streams) {
    const r = await getText(s.url, { headers, signal, cache });
    const media = hls.parseMedia(r.text, r.finalUrl);
    if (!media.segments.length) throw new CodedError('playlist_empty', 'The media playlist has no segments');
    if (media.segments.some(seg => seg.key && seg.key.method !== 'AES-128')) {
      throw new CodedError('drm', 'Stream is encrypted with a non-AES-128 method (DRM)');
    }
    s.segments = job.maxSegments ? media.segments.slice(0, job.maxSegments) : media.segments;
    s.duration = s.segments.reduce((t, seg) => t + seg.duration, 0);
    s.fmp4 = !!media.segments[0].map;
  }
  return { streams, extraSubs };
}

async function downloadHls(job, workDir, onProgress, signal) {
  const { streams, extraSubs } = await planHls(job, signal);
  const headers = job.source.headers;
  const keyCache = new Map();
  const getKey = async url => {
    if (!keyCache.has(url)) keyCache.set(url, request(url, { headers, signal }).then(r => r.buf));
    return keyCache.get(url);
  };

  const tasks = [];
  streams.forEach((s, si) => {
    s.dir = path.join(workDir, `s${si}`);
    s.segments.forEach((seg, i) => tasks.push({ s, seg, file: path.join(s.dir, `${String(i).padStart(6, '0')}.seg`) }));
  });
  for (const s of streams) await fsp.mkdir(s.dir, { recursive: true });

  const limiter = new AdaptiveLimiter({ start: 4, min: 2, max: 16 });
  const total = tasks.length;
  let done = 0;
  let bytes = 0;
  let retries = 0;
  const started = Date.now();
  const report = () => {
    const speed = limiter.rate();
    const totalEst = done ? (bytes / done) * total : 0;
    onProgress({
      phase: 'downloading',
      percent: total ? (done / total) * 100 : 0,
      bytes,
      totalBytes: Math.round(totalEst),
      speed: Math.round(speed),
      eta: speed > 0 ? Math.round((totalEst - bytes) / speed) : null,
      connections: limiter.limit,
    });
  };

  // Resume: count segments already on disk.
  for (const t of tasks) {
    try {
      const st = await fsp.stat(t.file);
      t.done = true;
      done++;
      bytes += st.size;
    } catch { /* not downloaded yet */ }
  }
  report();

  const fetchSegment = async t => {
    const { seg } = t;
    let { buf, res } = await request(seg.url, { headers, signal, range: seg.range });
    if (seg.key) {
      const key = await getKey(seg.key.url);
      const d = crypto.createDecipheriv('aes-128-cbc', key, ivForSegment(seg.key, seg.seq));
      buf = Buffer.concat([d.update(buf), d.final()]);
    }
    if (!t.s.fmp4) buf = stripToTsSync(buf);
    if (!isValidSegment(buf, t.s.fmp4, res.headers.get('content-type') || '')) {
      throw new InvalidSegment(`Invalid segment (${buf.length} bytes)`);
    }
    return buf;
  };

  await runAdaptive(tasks.filter(t => !t.done), limiter, async t => {
    let buf;
    for (let attempt = 1; ; attempt++) {
      try {
        buf = await fetchSegment(t);
        break;
      } catch (e) {
        if (signal?.aborted || e.fatal || attempt >= SEGMENT_ATTEMPTS) {
          if (e instanceof InvalidSegment) { e.detail = `Server sends corrupt segments: ${e.detail}`; e.message = e.detail; }
          throw e;
        }
        retries++;
        limiter.failure();
        await new Promise(r => setTimeout(r, Math.min(1500 * 2 ** attempt, 20000)));
      }
    }
    await fsp.writeFile(t.file + '.part', buf);
    await fsp.rename(t.file + '.part', t.file);
    done++;
    bytes += buf.length;
    limiter.success(buf.length);
    report();
  }, signal);

  // fMP4: every discontinuity group may use its own init segment (#EXT-X-MAP).
  for (const s of streams) {
    if (!s.fmp4) continue;
    const inits = new Map();
    for (const [i, seg] of s.segments.entries()) {
      if (!seg.map || (i && s.segments[i - 1].disc === seg.disc)) continue;
      const id = `${seg.map.url}#${seg.map.range ? `${seg.map.range.offset}-${seg.map.range.length}` : ''}`;
      if (!inits.has(id)) {
        const { buf } = await request(seg.map.url, { headers, signal, range: seg.map.range });
        const init = path.join(s.dir, `init${inits.size}.mp4`);
        await fsp.writeFile(init, buf);
        inits.set(id, init);
      }
      seg.initFile = inits.get(id);
    }
  }
  for (const [si, s] of streams.entries()) await writeConcatInputs(s, si, workDir);
  const stats = {
    downloadMs: Date.now() - started,
    bytes,
    retries,
    peakConnections: limiter.peak,
    finalConnections: limiter.limit,
  };
  return { streams, extraSubs, duration: streams[0].duration, stats };
}

async function downloadFile(job, workDir, onProgress, signal) {
  const file = path.join(workDir, 'direct.mp4');
  const { buf } = await request(job.source.url, { headers: job.source.headers, signal, timeoutMs: 60000, retries: 3 });
  await fsp.writeFile(file, buf);
  onProgress({ phase: 'downloading', percent: 100, bytes: buf.length, totalBytes: buf.length, speed: 0, eta: 0 });
  return { streams: [{ kind: 'video', file }], extraSubs: [], duration: null, direct: true };
}

async function fetchSubtitle(s, signal) {
  if (s.hls) {
    const { text, finalUrl } = await getText(s.url, { headers: s.headers, signal });
    const media = hls.parseMedia(text, finalUrl);
    const parts = [];
    for (const seg of media.segments) parts.push((await getText(seg.url, { headers: s.headers, signal })).text);
    return subs.mergeVttSegments(parts);
  }
  const { text } = await getText(s.url, { headers: s.headers, signal });
  return subs.toSrt(text);
}

// Write subtitles as "<base>.<lang>.srt" (UTF-8 with BOM). Returns written paths.
async function writeSubtitles(list, outDir, base, signal, log) {
  const suffixes = subtitleSuffixes(list);
  const written = [];
  let made = false; // the folder is made only when a file goes into it
  for (let i = 0; i < list.length; i++) {
    try {
      const srt = await fetchSubtitle(list[i], signal);
      if (!srt.trim()) continue;
      const file = path.join(outDir, `${base}.${suffixes[i]}.srt`);
      if (!made) {
        await fsp.mkdir(outDir, { recursive: true });
        made = true;
      }
      await fsp.writeFile(file, '﻿' + srt.replace(/\n/g, '\r\n'), 'utf8');
      written.push({ file, lang: guessLang(list[i]), label: list[i].label || '', forced: isForcedSubtitle(list[i]) });
    } catch (e) {
      if (signal?.aborted) throw e;
      log?.(`Altyazı indirilemedi (${list[i].label || list[i].url}): ${e.message}`);
    }
  }
  return written;
}

module.exports = {
  downloadHls, downloadFile, writeSubtitles, stripToTsSync, ivForSegment, planHls, isValidSegment, runAdaptive,
  discontinuityGroups, writeConcatInputs, planHlsSubtitles,
};
