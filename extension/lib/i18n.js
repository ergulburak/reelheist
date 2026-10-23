// Tiny i18n layer. Messages live in _locales/<lang>/messages.json in Chrome's format
// ({ key: { message, description } }) but use our own {name} placeholders.
// chrome.i18n is only used by the manifest (extName / extDesc) and for the browser UI language.

export const LOCALES = ['tr', 'en', 'es', 'pt_BR', 'fr', 'de', 'ru', 'ar', 'zh_CN', 'id', 'ja', 'hi'];
export const LOCALE_NAMES = {
  tr: 'Türkçe',
  en: 'English',
  es: 'Español',
  pt_BR: 'Português (Brasil)',
  fr: 'Français',
  de: 'Deutsch',
  ru: 'Русский',
  ar: 'العربية',
  zh_CN: '中文（简体）',
  id: 'Bahasa Indonesia',
  ja: '日本語',
  hi: 'हिन्दी',
};
const RTL = new Set(['ar']);

let lang = 'en';
let messages = {};
let fallback = {};

// Browser UI language (e.g. "pt-BR", "zh-TW", "en-GB") -> nearest supported locale.
export function resolveLang(ui) {
  const raw = String(ui || '').replace('-', '_');
  if (LOCALES.includes(raw)) return raw;
  const lower = raw.toLowerCase();
  if (lower.startsWith('pt')) return 'pt_BR';
  if (lower.startsWith('zh')) return 'zh_CN';
  const base = lower.split('_')[0];
  return LOCALES.includes(base) ? base : 'en';
}

async function defaultLoader(l) {
  const res = await fetch(chrome.runtime.getURL(`_locales/${l}/messages.json`));
  return res.json();
}

const flatten = json => Object.fromEntries(Object.entries(json || {}).map(([k, v]) => [k, v?.message ?? '']));

// wanted: a locale code or "auto". `loader` and `uiLanguage` are injectable for tests.
export async function initI18n(wanted, { loader = defaultLoader, uiLanguage } = {}) {
  const ui = uiLanguage ?? (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage ? chrome.i18n.getUILanguage() : 'en');
  lang = wanted === 'auto' || !LOCALES.includes(wanted) ? resolveLang(ui) : wanted;
  fallback = flatten(await loader('en').catch(() => ({})));
  messages = lang === 'en' ? fallback : flatten(await loader(lang).catch(() => ({})));
}

export function t(key, params) {
  let s = messages[key] ?? fallback[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
  return s;
}

export const currentLang = () => lang;
export const isRtl = () => RTL.has(lang);

// BCP-47 tag for <html lang> and Intl.
export const langTag = () => lang.replace('_', '-');

// Fills data-i18n / data-i18n-title / data-i18n-aria / data-i18n-placeholder elements and sets <html dir lang>.
export function applyI18n(root = document) {
  const doc = root.ownerDocument || root;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  doc.documentElement.lang = langTag();
  doc.documentElement.dir = isRtl() ? 'rtl' : 'ltr';
}
