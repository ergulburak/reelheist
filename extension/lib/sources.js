// Turn captured stream URLs into a short list of real choices.
// Variant/audio playlists of a master are hidden; ads lose to the longest stream.

import { formatDuration } from './estimate.js';
export { formatDuration };

// sources: [{url, kind, headers, time}], probe: async (source) => probeResult
// opts.fileLabel: translated label for a plain MP4 source.
// opts.minDuration: streams shorter than this (seconds) are marked `short` (trailer, ad).
export async function analyzeSources(sources, probe, opts = {}) {
  const recent = sources.slice(-10);
  const results = [];
  for (const s of recent) {
    if (s.kind === 'file') {
      results.push({ source: s, probe: { type: 'file', variants: [], audios: [], subtitles: [], duration: null } });
      continue;
    }
    try {
      results.push({ source: s, probe: await probe(s) });
    } catch (e) {
      results.push({ source: s, error: e.message });
    }
  }
  const children = new Set();
  for (const r of results) {
    if (r.probe?.type !== 'master') continue;
    for (const v of r.probe.variants) children.add(v.url);
    for (const a of r.probe.audios) if (a.url) children.add(a.url);
    for (const t of r.probe.subtitles) if (t.url) children.add(t.url);
  }
  const list = results.filter(r => r.probe && !children.has(r.source.url) && !children.has(r.probe.url || ''));
  const short = r => !!(opts.minDuration && r.probe.duration && r.probe.duration < opts.minDuration);
  // Known-short streams go last, even below a file of unknown length.
  list.sort((a, b) => short(a) - short(b) || (b.probe.duration || 0) - (a.probe.duration || 0));
  const out = list.map(r => ({ ...r, label: describe(r, opts), short: short(r) }));
  out.errors = results.filter(r => r.error).map(r => r.error);
  return out;
}

export function describe(r, { fileLabel = 'MP4 dosyası', units } = {}) {
  const p = r.probe;
  const parts = [];
  if (p.type === 'master' && p.variants.length) {
    const max = Math.max(...p.variants.map(v => v.height || 0));
    if (max) parts.push(`${max}p`);
  }
  if (p.type === 'file') parts.push(fileLabel);
  if (p.duration) parts.push(formatDuration(p.duration, units));
  let host = '';
  try { host = new URL(r.source.url).hostname; } catch { /* ignore */ }
  parts.push(host);
  return parts.join(' · ');
}

export function qualities(probe) {
  if (probe?.type === 'ytdlp') return probe.variants.map(v => v.height);
  if (!probe || probe.type !== 'master') return [];
  const hs = [...new Set(probe.variants.map(v => v.height).filter(Boolean))].sort((a, b) => b - a);
  return hs;
}

// Audio renditions that belong to the best variant's group.
export function audioTracks(probe, height) {
  if (probe?.type === 'ytdlp') return probe.audios;
  if (!probe || probe.type !== 'master') return [];
  const sorted = [...probe.variants].sort((a, b) => b.height - a.height);
  const v = (height && sorted.find(x => x.height <= height)) || sorted[0];
  const group = v?.audioGroup;
  return probe.audios.filter(a => a.url && (!group || a.groupId === group));
}
