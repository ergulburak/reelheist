'use strict';
// File naming and language helpers.

// ISO 639-1 → ISO 639-2/B (what ffmpeg writes into MP4 language tags).
const LANG3 = {
  tr: 'tur', en: 'eng', fr: 'fre', de: 'ger', es: 'spa', it: 'ita', pt: 'por', ru: 'rus',
  ar: 'ara', ja: 'jpn', ko: 'kor', zh: 'chi', nl: 'dut', pl: 'pol', sv: 'swe', no: 'nor',
  da: 'dan', fi: 'fin', el: 'gre', he: 'heb', hi: 'hin', hu: 'hun', cs: 'cze', ro: 'rum',
  uk: 'ukr', fa: 'per', az: 'aze', bg: 'bul', id: 'ind', th: 'tha', vi: 'vie',
};

// Words in labels (Turkish and English) → ISO 639-1.
const LABEL_WORDS = [
  [/t[üu]rk[çc]e|turkish|^tr$|\btur\b|dublaj/i, 'tr'],
  [/[iİ]ngilizce|english|^en$|\beng\b|orijinal|original/i, 'en'],
  [/frans[ıi]zca|french|fran[çc]ais|\bfre\b|\bfra\b/i, 'fr'],
  [/almanca|german|deutsch|\bger\b|\bdeu\b/i, 'de'],
  [/[iİ]spanyolca|spanish|espa[ñn]ol|\bspa\b/i, 'es'],
  [/[iİ]talyanca|italian|\bita\b/i, 'it'],
  [/portekizce|portuguese|\bpor\b/i, 'pt'],
  [/rus[çc]a|russian|\brus\b/i, 'ru'],
  [/arap[çc]a|arabic|\bara\b/i, 'ar'],
  [/japonca|japanese|\bjpn\b/i, 'ja'],
  [/korece|korean|\bkor\b/i, 'ko'],
  [/[çc]ince|chinese|\bchi\b|\bzho\b/i, 'zh'],
  [/hollandaca|dutch|\bdut\b|\bnld\b/i, 'nl'],
  [/leh[çc]e|polish|\bpol\b/i, 'pl'],
  [/yunanca|greek|\bgre\b/i, 'el'],
  [/[iİ]branice|hebrew|\bheb\b/i, 'he'],
  [/farsça|persian|\bper\b|\bfas\b/i, 'fa'],
];

const REVERSE3 = Object.fromEntries(Object.entries(LANG3).map(([a, b]) => [b, a]));

function normalizeLang(code) {
  if (!code) return '';
  const c = String(code).toLowerCase().split(/[-_]/)[0];
  if (c.length === 2) return c;
  if (REVERSE3[c]) return REVERSE3[c];
  if (c === 'deu') return 'de';
  if (c === 'fra') return 'fr';
  if (c === 'nld') return 'nl';
  if (c === 'zho') return 'zh';
  return c;
}

// Guess a 2-letter language code from lang field, label, then URL.
function guessLang({ lang, label, url } = {}) {
  if (lang) return normalizeLang(lang);
  for (const src of [label, fileNameOf(url)]) {
    if (!src) continue;
    for (const [re, code] of LABEL_WORDS) if (re.test(src)) return code;
  }
  const m = /[._-](tr|en|eng|tur|fre|fra|ger|deu|spa|ita|rus|ara)[._-]/i.exec(fileNameOf(url) || '');
  if (m) return normalizeLang(m[1]);
  return 'und';
}

function fileNameOf(url) {
  if (!url) return '';
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch { return String(url); }
}

function toLang3(code) {
  return LANG3[normalizeLang(code)] || (code && code.length === 3 ? code : 'und');
}

// Windows-safe file/folder name.
function sanitize(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .replace(/^(con|prn|aux|nul|com\d|lpt\d)$/i, '_$1')
    .slice(0, 150) || 'Video';
}

function pad2(n) { return String(n).padStart(2, '0'); }

// meta: {kind, name, season, episode, year, channel, folder, index}
function buildNames(meta) {
  const name = sanitize(meta.name);
  if (meta.kind === 'video') {
    // YouTube and similar: folder = playlist or channel, file = title.
    const folder = sanitize(meta.folder || meta.channel || 'YouTube');
    const base = meta.index ? sanitize(`${pad2(meta.index)} - ${name}`) : name;
    return { folder, base };
  }
  if (meta.kind === 'episode' && meta.season != null && meta.episode != null) {
    // Every episode has its own folder (sub) inside the series folder: video and subtitles together.
    const base = `${name}.S${pad2(meta.season)}E${pad2(meta.episode)}`;
    return { folder: name, base, sub: base };
  }
  const withYear = meta.year ? sanitize(`${name} (${meta.year})`) : name;
  return { folder: withYear, base: withYear };
}

// A forced track has only on-screen text (signs, foreign lines). Sources mark it with the
// HLS FORCED=YES flag, a "Forced"/"Zorunlu" label or a ".forced." part in the file name.
function isForcedSubtitle({ forced, label, url } = {}) {
  if (forced === true) return true;
  if (/(^|[^\p{L}])(forced|zorunlu)([^\p{L}]|$)/iu.test(label || '')) return true;
  return /[._-]forced[._-]/i.test(fileNameOf(url));
}

// Give each subtitle a unique ".lang" suffix: tr, tr.2, tr.3 … A forced track gets
// ".lang.forced" (the name Plex, Jellyfin and VLC read), so the page order never gives
// the plain ".tr.srt" name to a signs-only file.
function subtitleSuffixes(subs) {
  const seen = {};
  return subs.map(s => {
    const code = guessLang(s);
    const key = isForcedSubtitle(s) ? `${code}.forced` : code;
    seen[key] = (seen[key] || 0) + 1;
    return seen[key] === 1 ? key : `${key}.${seen[key]}`;
  });
}

// The .srt files of a job go into this folder inside the job's folder. Not "Subs" or "Subtitles":
// VLC and Plex scan those by themselves and would open one of the files instead of the MP4's track.
const SRT_DIR = 'srt';

module.exports = { SRT_DIR, guessLang, normalizeLang, toLang3, sanitize, buildNames, subtitleSuffixes, isForcedSubtitle };
