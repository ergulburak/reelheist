'use strict';
// YouTube (and other yt-dlp sites) through yt-dlp: probe, format choice, download, update.

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const P = require('./paths');
const { findFfmpeg } = require('./mux');
const { CodedError } = require('./errors');
const { normalizeLang, toLang3 } = require('./names');

const YTDLP_DIR = P.YTDLP_DIR;
const YTDLP_EXE = path.join(YTDLP_DIR, 'yt-dlp.exe');
const COOKIES_FILE = P.COOKIES_FILE;
const RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const UPDATE_EVERY_MS = 3 * 24 * 3600 * 1000;

function isYoutubeUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\.|^m\.|^music\./, '');
    return h === 'youtube.com' || h === 'youtu.be' || h === 'youtube-nocookie.com';
  } catch {
    return false;
  }
}

function findYtdlp() {
  if (fs.existsSync(YTDLP_EXE)) return YTDLP_EXE;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, 'yt-dlp.exe'))) return path.join(dir, 'yt-dlp.exe');
  }
  return null;
}

// curl.exe uses the Windows certificate store, so it works behind TLS inspection.
function curlDownload(url, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn('curl.exe', ['-sSL', '--ssl-no-revoke', '--fail', '-o', dest, url], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`curl ${code}: ${err.trim()}`))));
  });
}

let installing = null;
async function ensureYtdlp({ update = false, log = () => {} } = {}) {
  const existing = findYtdlp();
  const stale = existing === YTDLP_EXE && Date.now() - fs.statSync(YTDLP_EXE).mtimeMs > UPDATE_EVERY_MS;
  if (existing && !(update && stale)) return existing;
  if (!installing) {
    installing = (async () => {
      await fsp.mkdir(YTDLP_DIR, { recursive: true });
      const tmp = YTDLP_EXE + '.download';
      await curlDownload(RELEASE_URL, tmp);
      await fsp.rm(YTDLP_EXE, { force: true });
      await fsp.rename(tmp, YTDLP_EXE);
      log(`yt-dlp ${existing ? 'güncellendi' : 'indirildi'}`);
      return YTDLP_EXE;
    })().finally(() => { installing = null; });
  }
  try {
    return await installing;
  } catch (e) {
    if (existing) {
      log(`yt-dlp güncellenemedi: ${e.message}`);
      return existing;
    }
    throw new CodedError('ytdlp_missing', `yt-dlp could not be downloaded: ${e.message}`);
  }
}

function baseArgs() {
  const args = [
    '--no-color',
    '--compat-options', 'no-certifi', // Windows certificate store (TLS inspection on this PC)
    '--js-runtimes', `node:${process.execPath}`,
    '--remote-components', 'ejs:github',
  ];
  const ff = findFfmpeg();
  if (ff) args.push('--ffmpeg-location', path.dirname(ff));
  if (fs.existsSync(COOKIES_FILE)) args.push('--cookies', COOKIES_FILE);
  return args;
}

async function saveCookies(text) {
  if (typeof text !== 'string' || !text.includes('\t')) return;
  await fsp.mkdir(P.DATA_DIR, { recursive: true });
  await fsp.writeFile(COOKIES_FILE, text);
}

function run(exe, args, { signal, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true });
    let out = '';
    let err = '';
    let buf = '';
    const onAbort = () => p.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    p.stdout.on('data', d => {
      const s = d.toString('utf8');
      if (!onLine) { out += s; return; }
      buf += s;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    });
    p.stderr.on('data', d => { err = (err + d.toString('utf8')).slice(-8000); });
    p.on('error', reject);
    p.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(signal.reason || new Error('aborted'));
      if (code === 0) return resolve(out);
      const lines = err.split('\n').filter(l => /ERROR/.test(l));
      reject(new CodedError('ytdlp_failed', (lines.pop() || err.trim().split('\n').pop() || `yt-dlp exit code ${code}`).replace(/^ERROR:\s*/, '')));
    });
  });
}

// Raw yt-dlp info JSON, cached for a while (format URLs stay valid for hours).
const cache = new Map();
async function probeRaw(url, { signal, maxAgeMs = 10 * 60 * 1000 } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.time < maxAgeMs) return hit.json;
  const exe = await ensureYtdlp();
  const out = await run(exe, [...baseArgs(), '-J', '--no-playlist', '--no-warnings', url], { signal });
  const json = JSON.parse(out);
  cache.set(url, { json, time: Date.now() });
  return json;
}

async function probePlaylist(url, { signal } = {}) {
  const exe = await ensureYtdlp();
  const out = await run(exe, [...baseArgs(), '-J', '--flat-playlist', '--yes-playlist', '--no-warnings', url], { signal });
  const j = JSON.parse(out);
  return {
    id: j.id,
    title: j.title || 'Oynatma listesi',
    channel: j.channel || j.uploader || '',
    entries: (j.entries || []).filter(e => e && e.id).map((e, i) => ({
      index: i + 1,
      id: e.id,
      title: e.title || e.id,
      url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
      duration: e.duration || null,
    })),
  };
}

const isVideoOnly = f => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none');
const isAudioOnly = f => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none';
const isOriginal = f => /original/i.test(f.format_note || '') || (f.language_preference || 0) >= 10;

function codecRank(vcodec) {
  if (/^avc1/.test(vcodec)) return 3; // H.264: plays everywhere
  if (/^vp0?9/.test(vcodec)) return 2;
  if (/^av01/.test(vcodec)) return 1;
  return 0;
}

// Audio tracks: one entry per language.
function audioTracks(json) {
  const byLang = new Map();
  for (const f of json.formats || []) {
    if (!isAudioOnly(f) || /drc/i.test(f.format_id)) continue;
    const lang = f.language || '';
    const t = byLang.get(lang) || { lang, name: '', original: false };
    t.original = t.original || isOriginal(f);
    if (!t.name) t.name = (f.format_note || '').replace(/,.*$/, '').replace(/\s*\(default\)/i, '').replace(/\s*original/i, '').trim();
    byLang.set(lang, t);
  }
  const list = [...byLang.values()];
  if (list.length === 1) list[0].original = true;
  return list.map(t => ({ ...t, name: t.name || t.lang || 'Ses', isDefault: t.original }))
    .sort((a, b) => (b.original - a.original) || a.name.localeCompare(b.name));
}

const fmtSize = f => (f && (f.filesize || f.filesize_approx)) || null;

// The audio-only format selectFormats picks for a language: AAC first, then highest bitrate.
function pickAudioFormat(formats, lang) {
  const cands = formats.filter(f => isAudioOnly(f) && !/drc/i.test(f.format_id) && (f.language || '') === lang);
  cands.sort((a, b) => ((/^mp4a/.test(b.acodec) ? 1 : 0) - (/^mp4a/.test(a.acodec) ? 1 : 0)) || ((b.abr || 0) - (a.abr || 0)));
  return cands[0] || null;
}

// The video-only format selectFormats picks at exactly this height (best H.264, else best).
function pickVideoFormat(formats, height) {
  const cands = formats.filter(f => isVideoOnly(f) && f.height === height);
  cands.sort((a, b) => (codecRank(b.vcodec) - codecRank(a.vcodec)) || ((b.tbr || 0) - (a.tbr || 0)));
  return cands[0] || null;
}

function normalize(json) {
  const heights = new Map();
  for (const f of json.formats || []) {
    if (!f.height || !(isVideoOnly(f) || (f.vcodec && f.vcodec !== 'none'))) continue;
    const prev = heights.get(f.height);
    const rank = codecRank(f.vcodec || '');
    if (!prev || rank > prev.rank) heights.set(f.height, { height: f.height, codec: (f.vcodec || '').split('.')[0], rank });
  }
  const subs = Object.entries(json.subtitles || {})
    .filter(([lang]) => lang !== 'live_chat')
    .map(([lang, list]) => ({ lang, name: list[0]?.name || lang, auto: false }));
  const audios = audioTracks(json);
  const origLang = (audios.find(a => a.original)?.lang || json.language || '').split('-')[0];
  const autoKeep = new Set([`${origLang}-orig`, origLang, 'tr']);
  const autoSubs = Object.entries(json.automatic_captions || {})
    .filter(([lang]) => autoKeep.has(lang) && !json.subtitles?.[lang])
    .map(([lang, list]) => ({ lang, name: list[0]?.name || lang, auto: true }));
  return {
    type: 'ytdlp',
    url: json.webpage_url,
    title: json.title,
    channel: json.channel || json.uploader || '',
    duration: json.duration || null,
    isLive: !!json.is_live,
    variants: [...heights.values()].sort((a, b) => b.height - a.height).map(({ height, codec }) => ({ height, codec, size: fmtSize(pickVideoFormat(json.formats || [], height)) })),
    audios: audios.map(a => ({ ...a, size: fmtSize(pickAudioFormat(json.formats || [], a.lang)) })),
    subtitles: [...subs, ...autoSubs],
  };
}

// Pick exact format ids: best video up to the height (H.264 first), one audio per language.
function selectFormats(json, { height, langs } = {}) {
  const formats = json.formats || [];
  const videos = formats.filter(f => isVideoOnly(f) && f.height && (!height || f.height <= height));
  videos.sort((a, b) => (b.height - a.height) || (codecRank(b.vcodec) - codecRank(a.vcodec)) || ((b.tbr || 0) - (a.tbr || 0)));
  const video = videos[0] || null;
  const tracks = audioTracks(json);
  let wanted = Array.isArray(langs) && langs.length ? langs : null;
  if (!wanted) {
    // Default: original + Turkish dub when there is one.
    wanted = tracks.filter(t => t.original || normalizeLang(t.lang) === 'tr').map(t => t.lang);
    if (!wanted.length && tracks.length) wanted = [tracks[0].lang];
  }
  const audios = [];
  for (const lang of wanted) {
    // AAC first (best MP4 compatibility), then highest bitrate.
    const pick = pickAudioFormat(formats, lang);
    if (pick) audios.push(pick);
  }
  if (!video) {
    // Only muxed formats (old videos): best combined one.
    const muxed = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && (!height || !f.height || f.height <= height));
    muxed.sort((a, b) => (b.height || 0) - (a.height || 0));
    if (!muxed[0]) throw new CodedError('no_video', 'No usable video format found');
    return { ids: [muxed[0].format_id], formats: [muxed[0]], audios: [] };
  }
  if (!audios.length) {
    const any = formats.filter(f => isAudioOnly(f) && !/drc/i.test(f.format_id)).sort((a, b) => (b.abr || 0) - (a.abr || 0));
    if (any[0]) audios.push(any[0]);
  }
  const chosen = [video, ...audios];
  return { ids: chosen.map(f => f.format_id), formats: chosen, audios };
}

const sizeOf = f => f.filesize || f.filesize_approx || 0;

// yt-dlp subtitle options for the chosen languages ([] when none): SRT next to the video.
function subtitleArgs(subs) {
  const list = (subs || []).filter(s => s.lang);
  if (!list.length) return [];
  const args = ['--sub-langs', list.map(s => s.lang).join(','), '--sub-format', 'srt/vtt/best', '--convert-subs', 'srt'];
  if (list.some(s => !s.auto)) args.push('--write-subs');
  if (list.some(s => s.auto)) args.push('--write-auto-subs');
  return args;
}

// Subtitle files yt-dlp wrote for this job: "<base>.<lang>.srt".
async function writtenSubtitles(outDir, base) {
  return (await fsp.readdir(outDir))
    .filter(f => f.startsWith(`${base}.`) && f.endsWith('.srt'))
    .map(f => ({ file: path.join(outDir, f), lang: f.slice(base.length + 1, -4), label: '' }));
}

// Subtitle-only job: no video, only the SRT files. Returns {subtitles}.
async function downloadSubtitles(job, workDir, outDir, signal, log = () => {}) {
  if (job.cookies) await saveCookies(job.cookies);
  const exe = await ensureYtdlp();
  const json = await probeRaw(job.source.url, { signal, maxAgeMs: 30 * 60 * 1000 });
  if (json.is_live) throw new CodedError('live', 'Live streams cannot be downloaded');
  const infoFile = path.join(workDir, 'info.json');
  await fsp.writeFile(infoFile, JSON.stringify(json));
  const base = job.names.base;
  const subArgs = subtitleArgs(job.subtitles);
  if (!subArgs.length) throw new CodedError('no_subtitles', 'No subtitle language was chosen');
  await run(exe, [
    ...baseArgs(),
    '--load-info-json', infoFile,
    '--skip-download',
    '-P', outDir,
    '-P', `temp:${workDir}`,
    '-o', `${base}.%(ext)s`,
    '-o', `subtitle:${base}.%(ext)s`,
    '--no-mtime',
    ...subArgs,
  ], { signal });
  const subtitles = await writtenSubtitles(outDir, base);
  log(`yt-dlp altyazı: ${subtitles.map(s => s.lang).join(',') || '-'}`);
  return { subtitles };
}

// Download one job with yt-dlp. Returns {video, size, subtitles, stats, audioTracks}.
async function download(job, workDir, outDir, onProgress, signal, log = () => {}) {
  if (job.cookies) await saveCookies(job.cookies);
  const exe = await ensureYtdlp();
  const json = await probeRaw(job.source.url, { signal, maxAgeMs: 30 * 60 * 1000 });
  if (json.is_live) throw new CodedError('live', 'Live streams cannot be downloaded');
  const sel = selectFormats(json, { height: job.quality?.height || null, langs: Array.isArray(job.audio) ? job.audio : null });
  const infoFile = path.join(workDir, 'info.json');
  await fsp.writeFile(infoFile, JSON.stringify(json));

  const base = job.names.base;
  const sizes = sel.formats.map(sizeOf);
  const doneById = {};
  const totalById = {};
  const samples = [];
  const started = Date.now();
  const args = [
    ...baseArgs(),
    '--load-info-json', infoFile,
    '-f', sel.ids.join('+'),
    '--audio-multistreams',
    '--merge-output-format', 'mp4',
    '-P', outDir,
    '-P', `temp:${workDir}`,
    '-o', `${base}.%(ext)s`,
    '-o', `subtitle:${base}.%(ext)s`,
    '--no-mtime',
    '--no-part',
    '--continue',
    '--concurrent-fragments', '8',
    '--newline',
    '--progress-template', 'download:DL|%(info.format_id)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
  ];
  // yt-dlp's merge leaves dubbed tracks untagged and marks every track default:
  // tag language + title and make the original the only default.
  if (sel.audios.length > 1) {
    const tracks = audioTracks(json);
    const q = s => `"${String(s).replace(/"/g, '')}"`;
    const meta = [];
    let def = sel.audios.findIndex(a => tracks.find(t => t.lang === (a.language || ''))?.original);
    if (def < 0) def = 0;
    sel.audios.forEach((a, i) => {
      const t = tracks.find(x => x.lang === (a.language || ''));
      if (a.language) meta.push(`-metadata:s:a:${i}`, `language=${toLang3(a.language)}`);
      if (t?.name) meta.push(`-metadata:s:a:${i}`, q(`title=${t.name}${t.original ? ' (orijinal)' : ''}`));
      meta.push(`-disposition:a:${i}`, i === def ? 'default' : '0');
    });
    args.push('--postprocessor-args', `Merger+ffmpeg_o:${meta.join(' ')}`);
  }
  args.push(...subtitleArgs(job.subtitles));

  let phase = 'downloading';
  await run(exe, args, {
    signal,
    onLine: line => {
      if (line.startsWith('DL|')) {
        const [, id, dl, tb, te] = line.split('|');
        doneById[id] = Number(dl) || 0;
        // Sizes in the probe are estimates; trust what yt-dlp reports once a format starts.
        const reported = Number(tb) || Number(te) || 0;
        if (reported) totalById[id] = Math.max(reported, doneById[id]);
        const sum = Object.values(doneById).reduce((a, b) => a + b, 0);
        const tot = sel.ids.reduce((t, fid, i) => t + (totalById[fid] || sizes[i] || 0), 0);
        const now = Date.now();
        samples.push([now, sum]);
        while (samples.length > 1 && now - samples[0][0] > 5000) samples.shift();
        const span = (now - samples[0][0]) / 1000;
        const speed = span > 0.5 ? (sum - samples[0][1]) / span : 0;
        onProgress({
          phase: 'downloading',
          percent: tot ? Math.min(99, (sum / tot) * 100) : null,
          bytes: sum,
          totalBytes: Math.max(tot, sum),
          speed: Math.round(speed),
          eta: speed > 0 && tot > sum ? Math.round((tot - sum) / speed) : null,
        });
      } else if (/^\[Merger\]|^\[FFmpeg|^\[SubtitlesConvertor\]/.test(line) && phase !== 'muxing') {
        phase = 'muxing';
        onProgress({ phase: 'muxing', percent: null });
      }
    },
  });
  const downloadMs = Date.now() - started;

  const video = path.join(outDir, `${base}.mp4`);
  const st = await fsp.stat(video);
  const written = await writtenSubtitles(outDir, base);
  log(`yt-dlp biçimleri: ${sel.ids.join('+')}`);
  return {
    video,
    size: st.size,
    subtitles: written,
    audioTracks: sel.audios.map(a => a.language || a.format_note || a.format_id),
    stats: { downloadMs, bytes: st.size, retries: 0, formats: sel.ids.join('+') },
  };
}

module.exports = {
  isYoutubeUrl, findYtdlp, ensureYtdlp, probeRaw, probePlaylist, normalize, selectFormats, audioTracks,
  download, downloadSubtitles, subtitleArgs, saveCookies, run, baseArgs,
};
