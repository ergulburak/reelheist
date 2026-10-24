'use strict';
// Remux downloaded streams into one MP4 with ffmpeg (stream copy, every audio track kept).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { toLang3, normalizeLang } = require('./names');
const P = require('./paths');
const { CodedError } = require('./errors');

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

// [{type, duration, start}] of a finished file through ffprobe (next to ffmpeg); [] without it.
function probeStreams(ffmpeg, file) {
  const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (!fs.existsSync(ffprobe)) return Promise.resolve([]);
  return new Promise(resolve => {
    const p = spawn(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,duration,start_time', '-of', 'json', file],
      { windowsHide: true });
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

module.exports = { mux, findFfmpeg, buildArgs, inputArgs, inspect, run, probeStreams, checkOutput };
