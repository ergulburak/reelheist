// Settings view: theme, language, defaults, motion, site repositories, support, and about (spec §6.3).
import { api } from '../lib/helper.js';
import { LOCALES, LOCALE_NAMES, initI18n, applyI18n, t } from '../lib/i18n.js';
import { THEMES, applyTheme } from '../lib/theme.js';
import { saveUiSettings } from '../lib/ui-settings.js';
import { SUPPORT_URL, REPO_URL, RELEASES_URL } from '../lib/links.js';
import { createReposView } from './repos-view.js';

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

function parseLangList(raw) {
  const list = String(raw || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

export function createSettingsView({ bg, getUi, setUi, getSettings, setSettings, errText, onUiChanged, onPacksChanged, onUpdateInfo }) {
  const $ = id => document.getElementById(id);

  const reposView = createReposView({
    bg,
    getUi,
    setUi,
    errText,
    onPacksChanged,
  });

  function versionString() {
    try { return chrome.runtime?.getManifest?.()?.version || '0.1.0'; } catch { return '0.1.0'; }
  }

  function populateLangSelect() {
    const sel = $('setLang');
    if (!sel) return;
    const cur = getUi().lang || 'auto';
    const opts = [
      h('option', { value: 'auto', 'data-i18n': 'lang_auto' }, t('lang_auto')),
      ...LOCALES.map(code => h('option', { value: code }, LOCALE_NAMES[code] || code)),
    ];
    sel.replaceChildren(...opts);
    sel.value = LOCALES.includes(cur) ? cur : 'auto';
  }

  function populateQualitySelect() {
    const sel = $('setDefaultQuality');
    if (!sel) return;
    const cur = String(getUi().defaults?.quality || '');
    const opts = [
      h('option', { value: '', 'data-i18n': 'quality_highest' }, t('quality_highest')),
      ...[1080, 720, 480].map(p => h('option', { value: String(p) }, t('quality_p', { height: p }))),
    ];
    sel.replaceChildren(...opts);
    sel.value = ['1080', '720', '480'].includes(cur) ? cur : '';
  }

  function renderThemeSwatches() {
    const cur = getUi().theme || 'red';
    for (const btn of document.querySelectorAll('[data-theme-choice]')) {
      const active = btn.dataset.themeChoice === cur;
      btn.classList.toggle('sel', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function renderAbout() {
    const verEl = $('aboutVersion');
    if (verEl) verEl.textContent = t('lbl_version', { v: versionString() });
  }

  function syncFormFromState() {
    const ui = getUi();
    renderThemeSwatches();
    populateLangSelect();
    populateQualitySelect();

    const audioEl = $('setDefaultAudio');
    if (audioEl) audioEl.value = Array.isArray(ui.defaults?.audioLangs) ? ui.defaults.audioLangs.join(', ') : '';

    const subsEl = $('setDefaultSubs');
    if (subsEl) subsEl.value = Array.isArray(ui.defaults?.subLangs) ? ui.defaults.subLangs.join(', ') : '';

    const motionEl = $('setMotion');
    if (motionEl) motionEl.value = ['auto', 'on', 'off'].includes(ui.motion) ? ui.motion : 'auto';

    const outEl = $('outDir');
    if (outEl && getSettings()?.outDir !== undefined) outEl.value = getSettings().outDir;

    renderAbout();
  }

  async function saveDefaultsPatch(patch) {
    const cur = getUi().defaults || {};
    const nextDefaults = { ...cur, ...patch };
    if (!nextDefaults.quality) delete nextDefaults.quality;
    if (!nextDefaults.audioLangs) delete nextDefaults.audioLangs;
    if (!nextDefaults.subLangs) delete nextDefaults.subLangs;
    const next = await saveUiSettings({ defaults: nextDefaults });
    setUi(next);
    onUiChanged?.();
  }

  async function saveOutDir() {
    const outEl = $('outDir');
    if (!outEl) return;
    try {
      const saved = await api('POST', '/settings', { outDir: outEl.value });
      setSettings(saved);
      onUiChanged?.();
    } catch { /* helper might be offline */ }
  }

  function openExternal(url) {
    try { chrome.tabs.create({ url }); } catch { window.open(url, '_blank'); }
  }

  function wire() {
    for (const btn of document.querySelectorAll('[data-theme-choice]')) {
      btn.addEventListener('click', async () => {
        const choice = btn.dataset.themeChoice;
        if (!THEMES.includes(choice)) return;
        applyTheme(choice);
        const next = await saveUiSettings({ theme: choice });
        setUi(next);
        renderThemeSwatches();
        onUiChanged?.();
      });
    }

    $('setLang')?.addEventListener('change', async e => {
      const lang = e.target.value;
      const next = await saveUiSettings({ lang });
      setUi(next);
      await initI18n(lang);
      applyI18n(document);
      syncFormFromState();
      await reposView.refresh();
      onUiChanged?.();
    });

    $('setDefaultQuality')?.addEventListener('change', e => {
      const v = e.target.value;
      saveDefaultsPatch({ quality: v ? Number(v) : undefined });
    });

    $('setDefaultAudio')?.addEventListener('change', e => {
      saveDefaultsPatch({ audioLangs: parseLangList(e.target.value) });
    });

    $('setDefaultSubs')?.addEventListener('change', e => {
      saveDefaultsPatch({ subLangs: parseLangList(e.target.value) });
    });

    $('setMotion')?.addEventListener('change', async e => {
      const motion = e.target.value;
      const next = await saveUiSettings({ motion });
      setUi(next);
      onUiChanged?.();
    });

    $('saveSettings')?.addEventListener('click', saveOutDir);
    $('outDir')?.addEventListener('change', saveOutDir);

    $('supportBtn')?.addEventListener('click', () => openExternal(SUPPORT_URL));
    $('githubLink')?.addEventListener('click', () => openExternal(REPO_URL));
    $('licensesLink')?.addEventListener('click', () => openExternal(REPO_URL));

    $('checkUpdatesBtn')?.addEventListener('click', async () => {
      const box = $('updateStatus');
      if (!box) return;
      box.hidden = false;
      box.classList.remove('err');
      box.replaceChildren();
      try {
        const res = await api('GET', '/update?force=1');
        onUpdateInfo?.(res);
        if ((res?.available || res?.updateAvailable) && res.latest) {
          box.replaceChildren(
            h('span', {}, t('update_available', { v: res.latest })),
            h('button', {
              type: 'button',
              id: 'updateNowBtn',
              class: 'btn-update-now',
              onclick: async () => {
                try {
                  await api('POST', '/update');
                } catch {
                  openExternal(res.url || RELEASES_URL);
                }
              },
            }, t('btn_update_now')),
          );
        } else {
          box.textContent = t('update_up_to_date', { v: res?.current || versionString() });
        }
      } catch {
        box.classList.add('err');
        box.textContent = t('update_check_failed');
      }
    });

    reposView.wire();
    syncFormFromState();
  }

  async function open() {
    syncFormFromState();
    await reposView.refresh();
  }

  function refreshI18n() {
    syncFormFromState();
    reposView.refresh();
  }

  return { wire, open, refreshI18n };
}
