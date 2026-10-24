// Language list picker for the download defaults: chips with language names and an "add" menu,
// so nobody has to know language codes. The value is a list of primary codes ("tr", "en"),
// or an empty list for "Automatic".
import { t, langTag } from '../lib/i18n.js';
import { primaryLang } from '../lib/defaults.js';
import { icon } from './icons.js';

export const PICKER_LANGS = [
  'tr', 'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'ar', 'fa', 'he', 'hi',
  'id', 'ms', 'th', 'vi', 'ja', 'ko', 'zh', 'el', 'cs', 'ro', 'hu', 'sv', 'da', 'no', 'fi',
];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

// "tr" -> "Türkçe" in the interface language; unknown codes stay as they are.
export function langName(code) {
  try {
    const name = new Intl.DisplayNames([langTag()], { type: 'language' }).of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(langTag()) + name.slice(1);
  } catch { /* invalid code */ }
  return code;
}

export function createLangPicker(root, { onChange }) {
  let value = [];

  function render() {
    const chips = value.length
      ? value.map(code => h('span', { class: 'lang-chip' },
          h('span', {}, langName(code)),
          h('button', {
            type: 'button',
            class: 'lang-chip-x',
            title: t('btn_remove_lang', { name: langName(code) }),
            'aria-label': t('btn_remove_lang', { name: langName(code) }),
            onclick: () => set(value.filter(c => c !== code), true),
          }, icon('close')),
        ))
      : [h('span', { class: 'lang-chip auto' }, t('lang_auto'))];

    const choices = PICKER_LANGS
      .filter(code => !value.includes(code))
      .map(code => ({ code, name: langName(code) }))
      .sort((a, b) => a.name.localeCompare(b.name, langTag()));
    const add = h('select', {
      class: 'lang-add',
      'aria-label': t('btn_add_lang'),
      onchange: e => {
        const code = e.target.value;
        if (code) set([...value, code], true);
      },
    },
      h('option', { value: '' }, t('btn_add_lang')),
      choices.map(c => h('option', { value: c.code }, c.name)),
    );

    root.replaceChildren(...chips, add);
  }

  function set(list, notify = false) {
    value = [...new Set((list || []).map(primaryLang).filter(Boolean))];
    render();
    if (notify) onChange?.(value);
  }

  return { set, get: () => value };
}
