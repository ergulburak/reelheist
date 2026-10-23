'use strict';
// WebVTT → SRT conversion and HLS subtitle playlist merging.

function vttTimeToMs(t) {
  const parts = t.trim().split(':');
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) [h, m, s] = parts;
  else if (parts.length === 2) [m, s] = parts;
  else s = parts[0];
  return Math.round(((Number(h) * 60 + Number(m)) * 60 + Number(String(s).replace(',', '.'))) * 1000);
}

function msToSrtTime(ms) {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

// Parse VTT into cues [{start, end, text}] (ms). offsetMs is added to every cue.
function parseVtt(text, offsetMs = 0) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex(l => l.includes('-->'));
    if (idx < 0) continue;
    const [a, b] = lines[idx].split('-->');
    const start = vttTimeToMs(a);
    const end = vttTimeToMs(b.trim().split(/\s+/)[0]);
    const body = lines.slice(idx + 1).join('\n').trim();
    if (!body || Number.isNaN(start) || Number.isNaN(end)) continue;
    cues.push({ start: start + offsetMs, end: end + offsetMs, text: cleanCueText(body) });
  }
  return cues;
}

// Keep <i>, <b>, <u>; drop VTT voice/class/timestamp tags.
function cleanCueText(t) {
  return t
    .replace(/<(\/?)(i|b|u)(\.[^>]*)?>/g, '<$1$2>')
    .replace(/<(?!\/?(i|b|u)>)[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .trim();
}

function cuesToSrt(cues) {
  return cues
    .map((c, i) => `${i + 1}\n${msToSrtTime(c.start)} --> ${msToSrtTime(c.end)}\n${c.text}\n`)
    .join('\n');
}

function vttToSrt(text) {
  return cuesToSrt(parseVtt(text));
}

// Already SRT? (first cue line has a comma timestamp and no WEBVTT header)
function looksLikeSrt(text) {
  return !/^﻿?WEBVTT/.test(text) && /\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(text);
}

function toSrt(text) {
  if (looksLikeSrt(text)) {
    return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  }
  return vttToSrt(text);
}

// HLS WebVTT segments carry X-TIMESTAMP-MAP=MPEGTS:x,LOCAL:y; convert to an offset in ms.
function timestampMapOffset(text) {
  const m = /X-TIMESTAMP-MAP=([^\n]+)/.exec(text);
  if (!m) return 0;
  const mpegts = /MPEGTS:(\d+)/.exec(m[1]);
  const local = /LOCAL:([\d:.]+)/.exec(m[1]);
  const mpegMs = mpegts ? Number(mpegts[1]) / 90 : 0;
  const localMs = local ? vttTimeToMs(local[1]) : 0;
  return Math.round(mpegMs - localMs);
}

// Merge segmented VTT (HLS subtitle rendition). basePtsMs is subtracted so the first
// video PTS maps to zero (players expect zero-based subtitles next to an MP4).
function mergeVttSegments(texts, basePtsMs = 0) {
  const all = [];
  const seen = new Set();
  for (const t of texts) {
    const off = timestampMapOffset(t) - basePtsMs;
    for (const c of parseVtt(t, off)) {
      const k = `${c.start}|${c.end}|${c.text}`;
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(c);
    }
  }
  all.sort((a, b) => a.start - b.start);
  return cuesToSrt(all);
}

module.exports = { parseVtt, vttToSrt, toSrt, cuesToSrt, mergeVttSegments, msToSrtTime, vttTimeToMs };
