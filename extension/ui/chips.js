// Selection chips (Quality, Audio, Subtitles) and their dropdown menus.
import { qualities, audioTracks } from '../lib/sources.js';
import { t, langTag } from '../lib/i18n.js';
import { subtitleKey } from '../lib/defaults.js';
import { icon } from './icons.js';

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

export function langName(code) {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([langTag()], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

export function subLabel(s) {
  if (s.label) return s.label;
  if (s.lang) return langName(s.lang);
  try {
    return decodeURIComponent(new URL(s.url).pathname.split('/').pop());
  } catch {
    return s.url || '';
  }
}

function shortCode(lang, fallback = '') {
  if (lang) return String(lang).split(/[-_]/)[0].toUpperCase();
  const clean = String(fallback || '').trim();
  return clean.length <= 6 ? clean : clean.slice(0, 3).toUpperCase();
}

function summarizeCodes(codes, emptyLabel) {
  const uniq = [...new Set(codes.filter(Boolean))];
  if (!uniq.length) return emptyLabel;
  if (uniq.length <= 2) return uniq.join(' + ');
  return `${uniq.slice(0, 2).join(' + ')} +${uniq.length - 2}`;
}

export function createChipsController({
  getCurrent,
  getPick,
  getSubsList,
  onQualityChange,
  onSelectionChange,
}) {
  const $ = id => document.getElementById(id);
  let openMenu = null; // 'quality' | 'audio' | 'subs' | null

  function setMenu(which) {
    openMenu = openMenu === which ? null : which;
    for (const key of ['quality', 'audio', 'subs']) {
      const menu = $(`menu-${key}`);
      const chip = $(`chip-${key}`);
      if (menu) menu.hidden = openMenu !== key;
      if (chip) chip.setAttribute('aria-expanded', String(openMenu === key));
    }
  }

  function closeMenus() {
    if (!openMenu) return false;
    setMenu(null);
    return true;
  }

  function setChipContent(id, iconName, text, active = true) {
    const btn = $(id);
    if (!btn) return;
    btn.classList.toggle('on', active);
    btn.replaceChildren(
      icon(iconName),
      h('span', { class: 'chip-text' }, text),
      h('span', { class: 'chip-caret', 'aria-hidden': 'true' }, '▾'),
    );
  }

  function updateChipLabels() {
    const cur = getCurrent();
    const qSel = $('quality');
    const qVal = Number(qSel?.value) || null;
    const qLabel = qVal
      ? `${qVal}p`
      : t(cur?.probe?.type === 'file' ? 'quality_file' : 'quality_single');
    setChipContent('chip-quality', 'hd', qLabel, true);

    const audioBoxes = [...($('audios')?.querySelectorAll('input[type=checkbox]') || [])];
    const checkedAudio = audioBoxes.filter(b => b.checked);
    let audioText;
    if (!audioBoxes.length) {
      audioText = t('chip_audio_all');
    } else {
      const codes = checkedAudio.map(b => shortCode(b.dataset.lang, b.dataset.name));
      audioText = summarizeCodes(codes, t('chip_audio_all'));
    }
    setChipContent('chip-audio', 'speaker', audioText, true);

    const subs = getSubsList();
    const subBoxes = [...($('subs')?.querySelectorAll('input[type=checkbox]:checked') || [])];
    const subCodes = subBoxes.map(b => {
      const s = subs[Number(b.dataset.i)];
      return s ? shortCode(s.lang, s.label) : '';
    });
    const subText = summarizeCodes(subCodes, t('chip_subs_off'));
    setChipContent('chip-subs', 'cc', subText, subBoxes.length > 0);
  }

  function renderQualityOptions() {
    const cur = getCurrent();
    const pick = getPick();
    const q = $('quality');
    const listBox = $('qualityList');
    q.replaceChildren();
    listBox.replaceChildren();
    const hs = qualities(cur?.probe);
    if (hs.length) {
      const codecOf = v => cur.probe.variants?.find(x => x.height === v)?.codec;
      for (const v of hs) {
        const c = codecOf(v);
        const label = `${v}p${c && c !== 'avc1' && cur.probe.type === 'ytdlp' ? ` (${c.toUpperCase()})` : ''}`;
        q.append(h('option', { value: v }, label));
      }
      if (pick.height) q.value = String(pick.height);
      const rebuildButtons = () => {
        listBox.replaceChildren(...hs.map(v => {
          const c = codecOf(v);
          const label = `${v}p${c && c !== 'avc1' && cur.probe.type === 'ytdlp' ? ` (${c.toUpperCase()})` : ''}`;
          const active = String(q.value) === String(v);
          return h('button', {
            type: 'button',
            class: `menu-opt${active ? ' on' : ''}`,
            onclick: () => {
              q.value = String(v);
              rebuildButtons();
              setMenu(null);
              onQualityChange?.();
              updateChipLabels();
              onSelectionChange?.();
            },
          }, label);
        }));
      };
      rebuildButtons();
    } else {
      const singleLabel = t(cur?.probe?.type === 'file' ? 'quality_file' : 'quality_single');
      q.append(h('option', { value: '' }, singleLabel));
      listBox.append(h('div', { class: 'muted small' }, singleLabel));
    }
  }

  function renderAudios() {
    const cur = getCurrent();
    const pick = getPick();
    const list = audioTracks(cur?.probe, Number($('quality').value) || null);
    const box = $('audios');
    box.replaceChildren();
    if (!list.length) {
      box.append(h('div', { class: 'muted small' }, t('audio_all_included')));
      updateChipLabels();
      return;
    }
    const onCheck = () => {
      updateChipLabels();
      onSelectionChange?.();
    };
    if (cur?.probe?.type === 'ytdlp') {
      const isOn = a => pick.audioLangs === 'all' || pick.audioLangs.includes(a.lang);
      const row = a => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: isOn(a), 'data-lang': a.lang, onchange: onCheck }),
        `${a.name || langName(a.lang)}${a.original ? ` (${t('tag_original')})` : ''}`);
      box.append(...list.filter(isOn).map(row));
      const rest = list.filter(a => !isOn(a));
      if (rest.length) {
        box.append(h('details', { class: 'more' }, h('summary', {}, t('audios_other', { n: rest.length })), rest.map(row)));
      }
      updateChipLabels();
      return;
    }
    for (const a of list) {
      box.append(h('label', { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: pick.audioLangs === 'all' || (!!a.lang && pick.audioLangs.includes(a.lang)),
          'data-name': a.name,
          'data-lang': a.lang || '',
          onchange: onCheck,
        }),
        `${a.name || a.lang}${a.lang ? ` (${a.lang})` : ''}${a.isDefault ? ` · ${t('tag_default')}` : ''}`));
    }
    updateChipLabels();
  }

  function renderSubs() {
    const box = $('subs');
    box.replaceChildren();
    const list = getSubsList();
    if (!list.length) {
      box.append(h('div', { class: 'muted small' }, t('subs_none')));
      updateChipLabels();
      return;
    }
    const onCheck = () => {
      updateChipLabels();
      onSelectionChange?.();
    };
    const row = (s, i) => h('label', { class: 'check', title: s.url || s.lang },
      h('input', { type: 'checkbox', checked: s.checked ?? true, 'data-i': i, onchange: onCheck }),
      subLabel(s));
    const rows = list.map((s, i) => [s, row(s, i)]);
    box.append(...rows.filter(([s]) => s.checked ?? true).map(([, r]) => r));
    const rest = rows.filter(([s]) => !(s.checked ?? true));
    if (rest.length) {
      box.append(h('details', { class: 'more' }, h('summary', {}, t('subs_other', { n: rest.length })), rest.map(([, r]) => r)));
    }
    updateChipLabels();
  }

  function wire() {
    for (const key of ['quality', 'audio', 'subs']) {
      $(`chip-${key}`)?.addEventListener('click', e => {
        e.stopPropagation();
        setMenu(key);
      });
    }
    $('quality')?.addEventListener('change', () => {
      renderAudios();
      updateChipLabels();
      onSelectionChange?.();
    });
    document.addEventListener('click', e => {
      if (openMenu && !e.target.closest('.chips-area')) closeMenus();
    });
  }

  return {
    wire,
    renderAll() {
      renderQualityOptions();
      renderAudios();
      renderSubs();
      updateChipLabels();
    },
    renderAudios,
    renderSubs,
    updateChipLabels,
    closeMenus,
  };
}
export { subtitleKey };
