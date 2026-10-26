'use strict';
// Remux downloaded streams into one MP4 with ffmpeg (stream copy, every audio track kept).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { toLang3, normalizeLang } = require('./names');
const P = require('./paths');
const { CodedError } = require('./errors');
const notify = require('./notify');

function findFfmpeg() {
  const local = P.FFMPEG_EXE;
  if (fs.existsSync(local)) return local;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of ['ffmpeg.exe', 'ffmpeg']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// Input flags for one stream. `concat`: a concat demuxer list whose entries are concatf:
// lists (one per discontinuity group). `offset`: seconds this input starts after the
// earliest one (ffmpeg shifts every input to 0 on its own; -itsoffset restores the gap).
function inputArgs(s) {
  const a = [];
  if (s.concat) a.push('-protocol_whitelist', 'file,concatf,concat', '-safe', '0', '-f', 'concat');
  if (s.offset) a.push('-itsoffset', s.offset.toFixed(3));
  a.push('-i', s.file);
  return a;
}

// streams: [video, ...audioRenditions]; each {file, lang, name, isDefault, concat, offset}.
// muxedAudio: number of audio tracks already inside the video input; output audio
// indexes of the separate renditions start after them.
function buildArgs(streams, muxedAudio, outFile) {
  const args = ['-hide_banner', '-nostdin', '-y'];
  for (const s of streams) args.push(...inputArgs(s));
  const audios = streams.slice(1);
  args.push('-map', '0:v:0?', '-map', '0:a?');
  audios.forEach((_, i) => args.push('-map', `${i + 1}:a:0`));
  args.push('-c', 'copy');
  audios.forEach((a, i) => {
    const idx = muxedAudio + i;
    const lang = normalizeLang(a.lang);
    if (lang) args.push(`-metadata:s:a:${idx}`, `language=${toLang3(lang)}`);
    if (a.name) args.push(`-metadata:s:a:${idx}`, `title=${a.name}`);
  });
  if (audios.length && muxedAudio === 0) {
    let def = audios.findIndex(a => a.isDefault);
    if (def < 0) def = 0;
    audios.forEach((_, i) => args.push(`-disposition:a:${i}`, i === def ? 'default' : '0'));
  }
  args.push('-movflags', '+faststart', '-f', 'mp4', outFile);
  return args;
}

function run(ffmpeg, args, { onTime, signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    const onAbort = () => p.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    p.stderr.on('data', d => {
      const s = d.toString();
      err = (err + s).slice(-8000);
      const m = /time=(\d+):(\d+):([\d.]+)/.exec(s);
      if (m && onTime) onTime(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
    p.on('error', reject);
    p.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(signal.reason || new Error('aborted'));
      if (code === 0) resolve(err);
      else reject(new Error(`ffmpeg hata kodu ${code}: ${err.split('\n').filter(Boolean).slice(-3).join(' | ')}`));
    });
  });
}

// Audio stream count and start time of one input (reads ffmpeg's input dump).
function inspect(ffmpeg, s) {
  return new Promise(resolve => {
    const p = spawn(ffmpeg, ['-hide_banner', '-nostdin', ...inputArgs({ ...s, offset: 0 })], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => (err += d));
    p.on('close', () => {
      const m = /Duration: .*?, start: (-?[\d.]+)/.exec(err);
      resolve({ audio: (err.match(/Stream #\d+:\d+.*?: Audio:/g) || []).length, start: m ? Number(m[1]) : null });
    });
    p.on('error', () => resolve({ audio: 0, start: null }));
  });
}

// Renditions share one timeline: an audio playlist that starts 0.8 s after the video must
// start 0.8 s later in the MP4 too. A spread beyond this is a different timeline (or junk):
// then every input starts at 0, as before.
const MAX_ALIGN_SEC = 10;

async function mux(streams, outFile, { duration, onProgress, signal, log } = {}) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new CodedError('ffmpeg_missing', 'ffmpeg was not found');
  const info = await Promise.all(streams.map(s => inspect(ffmpeg, s)));
  const starts = info.map(i => i.start);
  for (const s of streams) s.offset = 0;
  if (streams.length > 1 && starts.every(t => t !== null)) {
    const min = Math.min(...starts);
    const spread = Math.max(...starts) - min;
    if (spread <= MAX_ALIGN_SEC) streams.forEach((s, i) => { s.offset = Number((starts[i] - min).toFixed(3)); });
    else log?.(`Ses/video zaman çizgileri ${spread.toFixed(1)} sn ayrık; hizalama yapılmadı`);
  }
  const tmp = outFile + '.part';
  await run(ffmpeg, buildArgs(streams, info[0].audio, tmp), {
    signal,
    onTime: t => onProgress?.({ phase: 'muxing', percent: duration ? Math.min(100, (t / duration) * 100) : null }),
  });
  await fs.promises.rm(outFile, { force: true });
  await fs.promises.rename(tmp, outFile);
  return outFile;
}

// ffprobe sits next to ffmpeg; null when either one is missing.
function ffprobePath() {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return null;
  const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return fs.existsSync(ffprobe) ? ffprobe : null;
}

// [{type, duration, start}] of a finished file through ffprobe (next to ffmpeg); [] without it.
function probeStreams(file) {
  const ffprobe = ffprobePath();
  if (!ffprobe) return Promise.resolve([]);
  return new Promise(resolve => {
    const p = spawn(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,duration,start_time', '-of', 'json', file],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('close', () => {
      try {
        resolve((JSON.parse(out).streams || []).map(s => ({
          type: s.codec_type, duration: Number(s.duration) || 0, start: Number(s.start_time) || 0,
        })));
      } catch { resolve([]); }
    });
    p.on('error', () => resolve([]));
  });
}

const mmss = sec => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

// Lengths that do not match mean missing or frozen parts: {code, detail} or null.
// expected: playlist duration in seconds (null when unknown).
function checkOutput(streams, expected) {
  const video = streams.find(s => s.type === 'video');
  if (!video) return null;
  const tol = Math.max(2, (expected || video.duration) * 0.01);
  const audios = streams.filter(s => s.type === 'audio');
  const parts = [`video ${mmss(video.duration)}`];
  let bad = false;
  for (const a of audios) {
    parts.push(`audio ${mmss(a.duration)}`);
    if (Math.abs(a.duration - video.duration) > tol) bad = true;
  }
  if (expected && Math.abs(video.duration - expected) > tol) {
    parts.push(`playlist ${mmss(expected)}`);
    bad = true;
  }
  return bad ? { code: 'av_mismatch', detail: parts.join(', ') } : null;
}

// ---------- subtitles inside the MP4 ----------

function languageName(code, uiLang) {
  try { return new Intl.DisplayNames([uiLang || 'en'], { type: 'language' }).of(code) || code; } catch { return code; }
}

// subs: [{file, lang, forced, label}] as written next to the video. Returns the tracks to add,
// [{file, lang3, title, isDefault}]. The first full (not forced) track in defaultLang turns on
// by itself and goes first (some TVs simply take the first track); every other track stays off.
// Titles are language names in the UI language; a forced track says so in its title.
function subtitleTrackPlan(subs, { defaultLang, uiLang } = {}) {
  const want = normalizeLang(defaultLang);
  const ui = normalizeLang(uiLang) || 'en';
  const forcedWord = notify.texts(uiLang).track_forced || 'forced';
  const tracks = subs.map(s => {
    const lang = normalizeLang(s.lang);
    const known = !!lang && lang !== 'und';
    const name = known ? languageName(lang, ui) : (s.label || 'Subtitle');
    return {
      file: s.file,
      lang,
      forced: !!s.forced,
      lang3: known ? toLang3(lang) : 'und',
      title: s.forced ? `${name} (${forcedWord})` : name,
    };
  });
  const def = tracks.findIndex(t => !t.forced && want && t.lang === want);
  const ordered = def < 0 ? tracks : [tracks[def], ...tracks.filter((_, i) => i !== def)];
  return ordered.map(t => ({ file: t.file, lang3: t.lang3, title: t.title, isDefault: t === tracks[def] }));
}

// Copies the video and audio of an MP4 and adds the subtitle files as mov_text tracks.
function embedArgs(video, tracks, outFile) {
  const args = ['-hide_banner', '-nostdin', '-y', '-i', video];
  for (const t of tracks) args.push('-i', t.file);
  args.push('-map', '0:v?', '-map', '0:a?');
  tracks.forEach((_, i) => args.push('-map', `${i + 1}:0`));
  args.push('-c', 'copy', '-c:s', 'mov_text');
  // The MP4 keeps the title as "name"; many players (VLC among them) show the handler name.
  tracks.forEach((t, i) => args.push(`-metadata:s:s:${i}`, `language=${t.lang3}`, `-metadata:s:s:${i}`, `title=${t.title}`,
    `-metadata:s:s:${i}`, `handler_name=${t.title}`));
  tracks.forEach((t, i) => args.push(`-disposition:s:${i}`, t.isDefault ? 'default' : '0'));
  args.push('-movflags', '+faststart', '-f', 'mp4', outFile);
  return args;
}

// Adds the subtitles to a finished MP4 in place. Returns the number of tracks added.
// On any failure the MP4 stays exactly as it was and the error is thrown.
async function embedSubtitles(videoFile, subs, { defaultLang, uiLang, signal } = {}) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new CodedError('ffmpeg_missing', 'ffmpeg was not found');
  const tracks = subtitleTrackPlan(subs, { defaultLang, uiLang });
  if (!tracks.length) return 0;
  const tmp = `${videoFile}.subs.part`;
  try {
    await run(ffmpeg, embedArgs(videoFile, tracks, tmp), { signal });
    try {
      await fs.promises.rename(tmp, videoFile);
    } catch {
      await fs.promises.rm(videoFile, { force: true });
      await fs.promises.rename(tmp, videoFile);
    }
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return tracks.length;
}

module.exports = {
  mux, findFfmpeg, buildArgs, inputArgs, inspect, run, probeStreams, checkOutput, ffprobePath,
  subtitleTrackPlan, embedArgs, embedSubtitles,
};
