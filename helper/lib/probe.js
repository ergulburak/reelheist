'use strict';
// Inspect a captured source URL: master playlist (qualities, audio, subtitles) or media playlist.

const { getText } = require('./http');
const hls = require('./hls');
const { CodedError } = require('./errors');

async function probe({ url, headers, kind, playlists }, { signal } = {}) {
  const cache = playlists || null;
  if (kind === 'file') {
    return { type: 'file', url, variants: [], audios: [], subtitles: [], duration: null };
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

// Highest variant whose height <= wanted; highest overall when wanted is null or nothing fits.
function pickVariant(variants, wantedHeight) {
  if (!variants.length) return null;
  const sorted = [...variants].sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  if (!wantedHeight) return sorted[0];
  return sorted.find(v => v.height <= wantedHeight) || sorted[sorted.length - 1];
}

module.exports = { probe, pickVariant };
