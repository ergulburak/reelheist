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

// streams: [video, ...audioRenditions]; each {file, lang, name, isDefault}.
// muxedAudio: number of audio tracks already inside the video input; output audio
// indexes of the separate renditions start after them.
function buildArgs(streams, muxedAudio, outFile) {
  const args = ['-hide_banner', '-nostdin', '-y'];
  for (const s of streams) args.push('-i', s.file);
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

// Count audio streams inside a file (reads ffmpeg's input dump).
function countAudio(ffmpeg, file) {
  return new Promise(resolve => {
    const p = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => (err += d));
    p.on('close', () => resolve((err.match(/Stream #\d+:\d+.*?: Audio:/g) || []).length));
    p.on('error', () => resolve(0));
  });
}

async function mux(streams, outFile, { duration, onProgress, signal } = {}) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new CodedError('ffmpeg_missing', 'ffmpeg was not found');
  const muxedAudio = await countAudio(ffmpeg, streams[0].file);
  const tmp = outFile + '.part';
  await run(ffmpeg, buildArgs(streams, muxedAudio, tmp), {
    signal,
    onTime: t => onProgress?.({ phase: 'muxing', percent: duration ? Math.min(100, (t / duration) * 100) : null }),
  });
  await fs.promises.rm(outFile, { force: true });
  await fs.promises.rename(tmp, outFile);
  return outFile;
}

module.exports = { mux, findFfmpeg, buildArgs, countAudio, run };
