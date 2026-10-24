'use strict';
// Minimal HLS (m3u8) parser: master playlists, media playlists, keys, maps, byte ranges.

function parseAttributes(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    attrs[m[1]] = v;
  }
  return attrs;
}

function resolveUrl(base, rel) {
  try { return new URL(rel, base).href; } catch { return rel; }
}

function isMaster(text) {
  return /#EXT-X-STREAM-INF/.test(text);
}

function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const variants = [];
  const media = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      if (j >= lines.length) break;
      const res = (a.RESOLUTION || '').split('x').map(Number);
      variants.push({
        url: resolveUrl(baseUrl, lines[j]),
        bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || 0),
        width: res[0] || 0,
        height: res[1] || 0,
        codecs: a.CODECS || '',
        audioGroup: a.AUDIO || null,
        subtitleGroup: a.SUBTITLES || null,
      });
      i = j;
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice(13));
      media.push({
        type: a.TYPE,
        groupId: a['GROUP-ID'] || '',
        name: a.NAME || '',
        lang: a.LANGUAGE || '',
        isDefault: a.DEFAULT === 'YES',
        forced: a.FORCED === 'YES',
        url: a.URI ? resolveUrl(baseUrl, a.URI) : null,
      });
    }
  }
  return {
    variants,
    audios: media.filter(m => m.type === 'AUDIO'),
    subtitles: media.filter(m => m.type === 'SUBTITLES' && m.url),
  };
}

function parseByteRange(str, prevEnd) {
  const [len, off] = str.split('@');
  const length = Number(len);
  const offset = off !== undefined ? Number(off) : prevEnd;
  return { offset, length };
}

function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const segments = [];
  let mediaSequence = 0;
  let key = null;
  let map = null;
  let duration = 0;
  let pendingDuration = 0;
  let pendingRange = null;
  let lastRangeEnd = { };
  let seq = 0;
  let disc = 0; // timestamps restart after every #EXT-X-DISCONTINUITY
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice(22)) || 0;
      seq = mediaSequence;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      if (segments.length) disc++;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice(11));
      if (!a.METHOD || a.METHOD === 'NONE') key = null;
      else key = { method: a.METHOD, url: a.URI ? resolveUrl(baseUrl, a.URI) : null, iv: a.IV || null };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice(11));
      map = { url: resolveUrl(baseUrl, a.URI), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice(17);
    } else if (!line.startsWith('#')) {
      const url = resolveUrl(baseUrl, line);
      let range = null;
      if (pendingRange) {
        range = parseByteRange(pendingRange, lastRangeEnd[url] || 0);
        lastRangeEnd[url] = range.offset + range.length;
      }
      segments.push({ url, duration: pendingDuration, seq, key, map, range, disc });
      duration += pendingDuration;
      pendingDuration = 0;
      pendingRange = null;
      seq++;
    }
  }
  return { segments, duration, mediaSequence, discontinuities: disc, endList: /#EXT-X-ENDLIST/.test(text) };
}

module.exports = { parseAttributes, parseMaster, parseMedia, isMaster, resolveUrl };
