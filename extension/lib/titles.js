// Page → {kind, name, season, episode, year}. Pure functions; also used by node tests.

// Universal URL patterns. Site-specific ones come from site packs.
const EPISODE_URL_PATTERNS = [
  /season-(\d{1,2})[/-]episode-(\d{1,4})/i,
  /(\d{1,2})-season-(\d{1,4})-episode/i,
  /[/_-]s(\d{1,2})e(\d{1,4})(?:\b|[/_-])/i,
];

// Pack regexes are compiled case-insensitive, like the pack validator does.
function packRegexes(list) {
  const out = [];
  for (const src of Array.isArray(list) ? list : []) {
    try { out.push(new RegExp(src, 'i')); } catch { /* skip bad regex */ }
  }
  return out;
}

function pathOf(url) {
  try { return decodeURIComponent(new URL(url).pathname); } catch { return url || ''; }
}

// A pack pattern may leave the season out of the match (an optional group, for sites whose
// first-season addresses carry no season): the episode is in season 1 then.
function fromGroups(m) {
  const g = m.groups || {};
  return { season: g.season === undefined ? 1 : Number(g.season), episode: Number(g.episode) };
}

const EPISODE_TEXT_PATTERNS = [
  /(\d{1,2})\s*\.\s*Sezon\s*(\d{1,4})\s*\.\s*B[öo]l[üu]m/i,
  /Sezon\s*(\d{1,2})\s*B[öo]l[üu]m\s*(\d{1,4})/i,
  /Season\s*(\d{1,2})\s*Episode\s*(\d{1,4})/i,
  /\bS(\d{1,2})\s*E(\d{1,4})\b/i,
];

// patterns: pack regex sources tried first (named groups season/episode).
export function parseEpisode(url, text, pack = null, patterns = null) {
  const path = pathOf(url);
  for (const re of packRegexes(patterns || pack?.title?.episodeUrl)) {
    const m = re.exec(path);
    if (m && m.groups) {
      const r = fromGroups(m);
      if (Number.isFinite(r.season) && Number.isFinite(r.episode)) return r;
    }
  }
  for (const re of EPISODE_URL_PATTERNS) {
    const m = re.exec(path);
    if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  }
  for (const re of EPISODE_TEXT_PATTERNS) {
    const m = re.exec(text || '');
    if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  }
  return null;
}

// Path part that identifies the series: everything before the season segment.
export function seriesKey(url, pack = null) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  const host = u.host.replace(/^www\./, '');
  const decoded = decodeURIComponent(u.pathname);
  if (pack?.title?.slugUrl) {
    for (const re of packRegexes([pack.title.slugUrl])) {
      const m = re.exec(decoded);
      if (m?.groups?.slug) return `${host}/${m.groups.slug}`.toLowerCase();
    }
  }
  const path = host + decoded;
  const m = /^(.*?)(?:\/?season-\d|-\d{1,2}-season|[/_-]s\d{1,2}e\d)/i.exec(path);
  return (m ? m[1] : path).replace(/\/+$/, '').toLowerCase();
}

const NOISE = [
  /\s*\|.*$/,
  // \b does not work around Turkish letters; use Unicode letter look-arounds.
  /(?<!\p{L})(full\s*hd|hd|1080p|720p)(?!\p{L})/giu,
  /(?<!\p{L})(t[üu]rk[çc]e\s*dublaj|dublaj|altyaz[ıi]l[ıi]|altyaz[ıi])(?!\p{L})/giu,
  /(?<!\p{L})([iİ]zle|watch|online)(?!\p{L})/giu,
];

export function cleanName(s, pack = null) {
  let t = String(s || '');
  for (const src of Array.isArray(pack?.title?.strip) ? pack.title.strip : []) {
    try { t = t.replace(new RegExp(src, 'gi'), ' '); } catch { /* skip bad regex */ }
  }
  for (const re of EPISODE_TEXT_PATTERNS) t = t.replace(new RegExp(re.source + '.*$', 'i'), '');
  for (const re of NOISE) t = t.replace(re, ' ');
  t = t.replace(/\(\s*\d{4}\s*\)/g, ' ').replace(/[\s\-–—:|,]+$/g, '').replace(/^[\s\-–—:|,]+/g, '');
  return t.replace(/\s+/g, ' ').trim();
}

function slugToName(slug) {
  return slug
    .replace(/-(\d{4})$/, '')
    .split('-')
    .filter(Boolean)
    .map(w => w.charAt(0).toLocaleUpperCase('tr') + w.slice(1))
    .join(' ');
}

function findYear(url, title, pack) {
  const m1 = /\((\d{4})\)/.exec(title || '');
  if (m1) return Number(m1[1]);
  const path = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
  if (pack?.title?.yearUrl) {
    for (const re of packRegexes([pack.title.yearUrl])) {
      const m = re.exec(path);
      const y = m && Number(m.groups?.year ?? m[1]);
      if (y) return y;
    }
  }
  const m2 = /-((?:19|20)\d{2})(?:-[a-z]+)?\/?$/i.exec(path);
  if (m2) return Number(m2[1]);
  return null;
}

function packSlug(url, pack) {
  if (!pack?.title?.slugUrl) return '';
  const path = pathOf(url);
  for (const re of packRegexes([pack.title.slugUrl])) {
    const m = re.exec(path);
    if (m?.groups?.slug) return m.groups.slug;
  }
  return '';
}

// info: {url, title, ogTitle, h1}; pack: optional site pack (its rules run first).
export function parsePage(info, pack = null) {
  const { url = '', title = '', ogTitle = '', h1 = '' } = info || {};
  const text = `${ogTitle} ${title} ${h1}`;
  const ep = parseEpisode(url, text, pack);
  let name = cleanName(ogTitle, pack) || cleanName(title, pack);
  if (ep) {
    // The URL slug is a reliable fallback for the series name.
    const m = /\/(?:series|tv|show)\/([^/]+)\//i.exec(url);
    const slug = packSlug(url, pack) || (m ? m[1] : '');
    if (!name && slug) name = slugToName(slug);
    return { kind: 'episode', name: name || 'Dizi', season: ep.season, episode: ep.episode, year: null };
  }
  let slug = packSlug(url, pack);
  if (!slug) {
    try { slug = new URL(url).pathname.split('/').filter(Boolean).pop() || ''; } catch { /* ignore */ }
  }
  if (!name && slug) name = slugToName(slug);
  return { kind: 'movie', name: name || 'Film', season: null, episode: null, year: findYear(url, `${ogTitle} ${title}`, pack) };
}

// links: [{href, text}] from the page; returns episodes of the same series, grouped by season.
export function collectEpisodes(pageUrl, links, pack = null) {
  const key = seriesKey(pageUrl, pack);
  const linkPatterns = [...(pack?.episodes?.linkUrl || []), ...(pack?.title?.episodeUrl || [])];
  const byUrl = new Map();
  for (const l of links) {
    if (!l.href || byUrl.has(l.href)) continue;
    const ep = parseEpisode(l.href, '', pack, linkPatterns.length ? linkPatterns : null);
    if (!ep) continue;
    if (key && seriesKey(l.href, pack) !== key) continue;
    byUrl.set(l.href.split('#')[0], { url: l.href.split('#')[0], ...ep, text: (l.text || '').trim().slice(0, 80) });
  }
  return [...byUrl.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}
