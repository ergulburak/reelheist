// Download size and duration estimates, plus Intl-based byte and duration formatting.

const AUDIO_BITRATE_BPS = 128_000;

function pickMasterVariant(variants, height) {
  if (!Array.isArray(variants) || !variants.length) return null;
  const sorted = [...variants].sort(
    (a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0),
  );
  return (height && sorted.find(v => v.height <= height)) || sorted[0];
}

// probe: helper /api/probe result. opts: { height, audioLangs }.
export function estimateBytes(probe, { height = null, audioLangs = 'all' } = {}) {
  if (!probe || typeof probe !== 'object') return null;

  if (probe.type === 'master') {
    const dur = Number(probe.duration);
    if (!(dur > 0)) return null;
    const v = pickMasterVariant(probe.variants, height);
    const bw = Number(v?.bandwidth);
    if (!(bw > 0)) return null;
    const group = v.audioGroup;
    const tracks = (probe.audios || []).filter(
      a => a.url !== null && (!group || !a.groupId || a.groupId === group),
    );
    let audioCount = 0;
    if (!audioLangs || audioLangs === 'all') {
      audioCount = tracks.length;
    } else if (Array.isArray(audioLangs)) {
      audioCount = tracks.length
        ? tracks.filter(a => audioLangs.includes(a.lang) || audioLangs.includes(a.name)).length
        : audioLangs.length;
    }
    const videoBytes = (bw * dur) / 8;
    const audioBytes = audioCount * ((AUDIO_BITRATE_BPS * dur) / 8);
    return Math.round(videoBytes + audioBytes);
  }

  if (probe.type === 'ytdlp') {
    const sorted = [...(probe.variants || [])].sort((a, b) => (b.height || 0) - (a.height || 0));
    const v = (height && sorted.find(x => x.height <= height)) || sorted[0];
    if (!v || !(v.size > 0)) return null;
    const tracks = probe.audios || [];
    const picked = !audioLangs || audioLangs === 'all'
      ? tracks
      : tracks.filter(a => Array.isArray(audioLangs) && (audioLangs.includes(a.lang) || audioLangs.includes(a.name)));
    let sum = v.size;
    for (const a of picked) {
      if (a.size > 0) sum += a.size;
    }
    return Math.round(sum);
  }

  return null;
}

export function estimateSeconds(bytes, avgBytesPerSec = 5e6) {
  if (!(bytes > 0) || !(avgBytesPerSec > 0)) return 0;
  return Math.round(bytes / avgBytesPerSec);
}

export function formatBytes(n, lang = 'en') {
  const tag = String(lang || 'en').replace('_', '-');
  const bytes = Number(n) || 0;
  try {
    if (bytes >= 1e9) {
      return new Intl.NumberFormat(tag, {
        style: 'unit',
        unit: 'gigabyte',
        unitDisplay: 'short',
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(bytes / 1e9);
    }
    return new Intl.NumberFormat(tag, {
      style: 'unit',
      unit: 'megabyte',
      unitDisplay: 'short',
      maximumFractionDigits: 0,
    }).format(bytes > 0 ? Math.max(1, Math.round(bytes / 1e6)) : 0);
  } catch {
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
  }
}

// lang: BCP-47 / locale code (e.g. "tr", "en", "pt_BR") or legacy { h, m } unit labels.
export function formatDuration(sec, lang = 'tr') {
  const total = Math.max(0, Number(sec) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (lang && typeof lang === 'object') {
    const { h: uh = 'sa', m: um = 'dk' } = lang;
    return h ? `${h} ${uh} ${m} ${um}` : `${m} ${um}`;
  }
  const tag = String(lang || 'tr').replace('_', '-');
  const stripDot = tag.toLowerCase().startsWith('tr');
  try {
    const fmt = (val, unit) => {
      const s = new Intl.NumberFormat(tag, { style: 'unit', unit, unitDisplay: 'short' }).format(val);
      return stripDot ? s.replace(/\.$/, '') : s;
    };
    return h ? `${fmt(h, 'hour')} ${fmt(m, 'minute')}` : fmt(m, 'minute');
  } catch {
    return h ? `${h} h ${m} min` : `${m} min`;
  }
}
