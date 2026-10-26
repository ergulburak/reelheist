// Default quality / audio / subtitle choices (spec 5b) and per-site memory.
import { qualities, audioTracks } from './sources.js';
import { loadUiSettings, saveUiSettings } from './ui-settings.js';

export const MEMORY_CAP = 200;

// Primary language subtag, lower case: "en-US" and "pt_BR" -> "en", "pt".
export const primaryLang = l => String(l || '').toLowerCase().split(/[-_]/)[0];

// Stable key of a subtitle: YouTube "lang" or "lang:auto"; page/HLS "lang" or the label.
export function subtitleKey(s) {
  if (s.auto) return `${s.lang}:auto`;
  return s.lang || s.label || s.name || '';
}

function pickHeight(probe, quality) {
  const hs = qualities(probe);
  if (!hs.length) return null;
  const cap = Number(quality) > 0 ? Number(quality) : Infinity;
  let pool = hs.filter(h => h <= cap);
  if (!pool.length) pool = [Math.min(...hs)];
  if (probe.type === 'ytdlp') {
    const avc = pool.filter(h => probe.variants.find(v => v.height === h)?.codec === 'avc1');
    if (avc.length) return Math.max(...avc);
  }
  return Math.max(...pool);
}

function originalLang(probe) {
  if (probe?.type === 'ytdlp') return primaryLang((probe.audios || []).find(a => a.original)?.lang);
  return primaryLang((probe?.audios || []).find(a => a.isDefault && a.lang)?.lang);
}

function pickAudio(probe, height, wantPrimaries, explicit) {
  const list = audioTracks(probe, height);
  if (!list.length) return 'all';
  const isYt = probe.type === 'ytdlp';
  if (!isYt && !list.some(a => a.lang)) return 'all'; // HLS without language info
  const want = new Set(explicit ?? wantPrimaries);
  const orig = originalLang(probe);
  if (!explicit && orig) want.add(orig);
  const langs = list.filter(a => a.lang && want.has(primaryLang(a.lang))).map(a => a.lang);
  if (langs.length) return [...new Set(langs)];
  if (isYt) return list[0] ? [list[0].lang] : [];
  return 'all';
}

function subCandidates(probe, extra) {
  if (probe?.type === 'ytdlp') return (probe.subtitles || []).map(s => ({ ...s, key: subtitleKey(s) }));
  return [...(extra || []), ...(probe?.subtitles || [])].map(s => ({ ...s, key: subtitleKey({ lang: s.lang, label: s.label || s.name }) }));
}

// probe: popup probe result. opts: { uiLang, defaults, memory (siteMemory map), host, subs (page subtitles) }.
export function chooseDefaults(probe, { uiLang = 'en', defaults = {}, memory = {}, host = '', subs = [] } = {}) {
  const mem = host ? memory?.[host] : null;
  const ui = primaryLang(uiLang);

  let height = pickHeight(probe, defaults.quality);
  if (mem?.height && qualities(probe).includes(mem.height)) height = mem.height;

  const explicitAudio = Array.isArray(defaults.audioLangs) ? defaults.audioLangs.map(primaryLang) : null;
  let audioLangs = pickAudio(probe, height, [ui], explicitAudio);
  if (mem && (mem.audioLangs === 'all' || Array.isArray(mem.audioLangs))) {
    const avail = audioTracks(probe, height);
    if (mem.audioLangs === 'all') {
      if (!avail.length || probe?.type !== 'ytdlp') audioLangs = 'all';
    } else {
      const kept = avail.map(a => a.lang).filter(l => l && mem.audioLangs.includes(l));
      if (kept.length) audioLangs = [...new Set(kept)];
    }
  }

  const cands = subCandidates(probe, subs);
  const explicitSubs = Array.isArray(defaults.subLangs) ? defaults.subLangs.map(primaryLang) : null;
  const wantSubs = new Set(explicitSubs ?? [ui, 'en', originalLang(probe)].filter(Boolean));
  let subtitleKeys = cands.filter(s => !s.auto && s.lang && wantSubs.has(primaryLang(s.lang))).map(s => s.key);
  if (mem && Array.isArray(mem.subtitleKeys)) {
    const kept = cands.map(s => s.key).filter(k => mem.subtitleKeys.includes(k));
    // Keep an explicit "no subtitles" choice; drop only when every remembered key is gone.
    if (kept.length || !mem.subtitleKeys.length) subtitleKeys = kept;
  }
  return { height, audioLangs, subtitleKeys: [...new Set(subtitleKeys)] };
}

// "Put subtitles inside the MP4" (Settings → Download, on by default). Returns the job field:
// { lang, keepSrt }: the subtitle that turns on by itself (the first default subtitle language, else
// the interface language) and "Keep .srt files" (on by default), or null when the setting is off.
export function embedSubsOption(ui, uiLang) {
  const d = ui?.defaults || {};
  if (d.embedSubs === false) return null;
  const first = Array.isArray(d.subLangs) && d.subLangs.length ? d.subLangs[0] : uiLang;
  return { lang: primaryLang(first), keepSrt: d.keepSrt !== false };
}

// Pure part of rememberChoice: returns a new map, at most MEMORY_CAP hosts (oldest "t" dropped).
export function applyRemember(siteMemory, host, choice, now = Date.now()) {
  const next = { ...(siteMemory || {}) };
  next[host] = {
    audioLangs: choice.audioLangs,
    subtitleKeys: choice.subtitleKeys || [],
    height: choice.height ?? null,
    t: now,
  };
  const hosts = Object.keys(next);
  if (hosts.length > MEMORY_CAP) {
    hosts.sort((a, b) => (next[a].t || 0) - (next[b].t || 0));
    for (const h of hosts.slice(0, hosts.length - MEMORY_CAP)) delete next[h];
  }
  return next;
}

export async function rememberChoice(host, choice) {
  if (!host) return;
  const s = await loadUiSettings();
  await saveUiSettings({ siteMemory: applyRemember(s.siteMemory, host, choice) });
}
