'use strict';
// Inspect a captured source URL: master playlist (qualities, audio, subtitles) or media playlist.

const { spawn } = require('child_process');
const { getText, pickHeaders } = require('./http');
const { ffprobePath } = require('./mux');
const hls = require('./hls');
const { CodedError } = require('./errors');

async function probe({ url, headers, kind, playlists }, { signal } = {}) {
  const cache = playlists || null;
  if (kind === 'file') {
    const duration = await fileDuration(url, headers, { signal });
    return { type: 'file', url, variants: [], audios: [], subtitles: [], duration };
  }
  const { text, finalUrl } = await getText(url, { headers, signal, retries: 2, cache });
  if (!/^﻿?#EXTM3U/.test(text.trimStart())) {
    throw new CodedError('not_hls', 'The source is not an HLS playlist');
  }
  if (hls.isMaster(text)) {
    const m = hls.parseMaster(text, finalUrl);
    // Duration from the best variant (cheap: one more playlist request).
    let duration = null;
    const best = pickVariant(m.variants, null);
    if (best) {
      try {
        const v = await getText(best.url, { headers, signal, retries: 1, cache });
        duration = Math.round(hls.parseMedia(v.text, v.finalUrl).duration);
      } catch { /* duration stays unknown */ }
    }
    return { type: 'master', url: finalUrl, variants: m.variants, audios: m.audios, subtitles: m.subtitles, duration };
  }
  const media = hls.parseMedia(text, finalUrl);
  return {
    type: 'media',
    url: finalUrl,
    variants: [],
    audios: [],
    subtitles: [],
    duration: Math.round(media.duration),
    segments: media.segments.length,
  };
}

// Duration in seconds of a remote file through ffprobe; null when unknown or on any failure.
// The URL comes from a web page: only http(s) is opened, never a local file or another protocol.
function fileDuration(url, headers, { signal } = {}) {
  const ffprobe = ffprobePath();
  if (!ffprobe || signal?.aborted || !/^https?:\/\//i.test(String(url || ''))) return Promise.resolve(null);
  return new Promise(resolve => {
    const p = spawn(ffprobe, fileDurationArgs(url, headers), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    let settled = false;
    const done = v => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const onAbort = () => { p.kill(); done(null); };
    const timer = setTimeout(onAbort, 15000);
    signal?.addEventListener('abort', onAbort, { once: true });
    p.stdout.on('data', d => (out += d));
    p.on('close', () => {
      try {
        const d = Math.round(Number(JSON.parse(out).format?.duration));
        done(d > 0 ? d : null);
      } catch { done(null); }
    });
    p.on('error', () => done(null));
  });
}

// A header value with a line break would add a header of its own: line breaks become spaces.
function fileDurationArgs(url, headers) {
  const clean = v => String(v).replace(/[\r\n]+/g, ' ').trim();
  const h = Object.entries(pickHeaders(headers)).map(([k, v]) => `${clean(k)}: ${clean(v)}\r\n`).join('');
  return ['-v', 'error', '-protocol_whitelist', 'http,https,tls,tcp,crypto', '-headers', h,
    '-show_entries', 'format=duration', '-of', 'json', url];
}

// Highest variant whose height <= wanted; highest overall when wanted is null or nothing fits.
function pickVariant(variants, wantedHeight) {
  if (!variants.length) return null;
  const sorted = [...variants].sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  if (!wantedHeight) return sorted[0];
  return sorted.find(v => v.height <= wantedHeight) || sorted[sorted.length - 1];
}

module.exports = { probe, pickVariant, fileDuration, fileDurationArgs };
