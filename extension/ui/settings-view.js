// Settings view: theme, language, defaults, motion, site repositories, support, and about (spec §6.3),
// split into Appearance / Downloads / Repositories / About tabs. Languages are picked by name,
// the download folder through the helper's native folder dialog.
import { api } from '../lib/helper.js';
import { LOCALES, LOCALE_NAMES, initI18n, applyI18n, t, isRtl } from '../lib/i18n.js';
import { THEMES, applyTheme } from '../lib/theme.js';
import { saveUiSettings } from '../lib/ui-settings.js';
import { SUPPORT_URL, REPO_URL, RELEASES_URL } from '../lib/links.js';
import { createReposView } from './repos-view.js';
import { createLangPicker } from './lang-picker.js';
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

// Settings are split into tabs; the last open tab is remembered for the next time the popup opens.
const TABS = ['look', 'download', 'repos', 'about'];
const TAB_KEY = 'reelheist.settingsTab';

function readTab() {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return TABS.includes(v) ? v : TABS[0];
  } catch { return TABS[0]; }
}

export function createSettingsView({ bg, getUi, setUi, getSettings, setSettings, errText, onUiChanged, onPacksChanged, onUpdateInfo }) {
  const $ = id => document.getElementById(id);
  let audioPicker = null;
  let subsPicker = null;

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

  function selectTab(name, { focus = false } = {}) {
    for (const tab of document.querySelectorAll('[data-set-tab]')) {
      const active = tab.dataset.setTab === name;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    }
    for (const panel of document.querySelectorAll('[data-set-panel]')) panel.hidden = panel.dataset.setPanel !== name;
    try { localStorage.setItem(TAB_KEY, name); } catch { /* storage might be blocked */ }
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

    audioPicker?.set(Array.isArray(ui.defaults?.audioLangs) ? ui.defaults.audioLangs : []);
    subsPicker?.set(Array.isArray(ui.defaults?.subLangs) ? ui.defaults.subLangs : []);

    const motionEl = $('setMotion');
    if (motionEl) motionEl.value = ['auto', 'on', 'off'].includes(ui.motion) ? ui.motion : 'auto';

    const overlayEl = $('setOverlay');
    if (overlayEl) overlayEl.checked = ui.overlay !== false;

    const embedEl = $('setEmbedSubs');
    if (embedEl) embedEl.checked = ui.defaults?.embedSubs !== false;
    // Without embedding the .srt files are the only subtitles: they always stay.
    const keepEl = $('setKeepSrt');
    if (keepEl) {
      keepEl.disabled = ui.defaults?.embedSubs === false;
      keepEl.checked = keepEl.disabled || ui.defaults?.keepSrt !== false;
    }

    const outEl = $('outDir');
    if (outEl && getSettings()?.outDir !== undefined) {
      outEl.value = getSettings().outDir;
      outEl.title = getSettings().outDir;
    }

    const notifyEl = $('setNotify');
    if (notifyEl) notifyEl.value = ['all', 'errors', 'off'].includes(getSettings()?.notify) ? getSettings().notify : 'all';

    renderMemory();
    renderAbout();
  }

  function renderMemory() {
    const btn = $('clearMemoryBtn');
    if (!btn) return;
    const n = Object.keys(getUi().siteMemory || {}).length;
    btn.textContent = t('btn_clear_site_memory', { n });
    btn.disabled = n === 0;
  }

  function setOutDirStatus(msg, isError = false) {
    const el = $('outDirStatus');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('err', isError);
    el.hidden = !msg;
  }

  async function saveDefaultsPatch(patch) {
    const cur = getUi().defaults || {};
    const nextDefaults = { ...cur, ...patch };
    if (!nextDefaults.quality) delete nextDefaults.quality;
    if (!nextDefaults.audioLangs) delete nextDefaults.audioLangs;
    if (!nextDefaults.subLangs) delete nextDefaults.subLangs;
    if (nextDefaults.embedSubs !== false) delete nextDefaults.embedSubs; // on is the default: store only "off"
    if (nextDefaults.keepSrt !== false) delete nextDefaults.keepSrt;
    const next = await saveUiSettings({ defaults: nextDefaults });
    setUi(next);
    onUiChanged?.();
  }

  async function saveOutDir(dir) {
    try {
      const saved = await api('POST', '/settings', { outDir: dir });
      setSettings(saved);
      syncFormFromState();
      onUiChanged?.();
    } catch (e) {
      setOutDirStatus(errText(e), true);
    }
  }

  // Native folder dialog through the helper. A helper older than /pick-folder answers 404;
  // then the path box becomes editable as before.
  async function pickOutDir() {
    const outEl = $('outDir');
    const btn = $('pickOutDir');
    setOutDirStatus('');
    if (btn) btn.disabled = true;
    try {
      const res = await api('POST', '/pick-folder', { initial: outEl?.value || '', title: t('lbl_outdir') });
      if (res?.path) await saveOutDir(res.path);
    } catch (e) {
      if (/^not found$/.test(e?.code) && outEl) {
        outEl.readOnly = false;
        outEl.focus();
        setOutDirStatus(t('hint_folder_type'));
      } else {
        setOutDirStatus(errText(e), true);
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function openExternal(url) {
    try { chrome.tabs.create({ url }); } catch { window.open(url, '_blank'); }
  }

  function wire() {
    for (const tab of document.querySelectorAll('[data-set-tab]')) {
      tab.addEventListener('click', () => selectTab(tab.dataset.setTab));
    }

    // Arrow keys move between tabs (mirrored in RTL), Home/End jump to the ends.
    $('setTabs')?.addEventListener('keydown', e => {
      const cur = TABS.indexOf(document.activeElement?.dataset?.setTab);
      if (cur < 0) return;
      const step = isRtl() ? -1 : 1;
      let next;
      if (e.key === 'ArrowRight') next = cur + step;
      else if (e.key === 'ArrowLeft') next = cur - step;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = TABS.length - 1;
      else return;
      e.preventDefault();
      selectTab(TABS[(next + TABS.length) % TABS.length], { focus: true });
    });

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

    const audioRoot = $('setDefaultAudio');
    if (audioRoot) {
      audioPicker = createLangPicker(audioRoot, {
        onChange: list => saveDefaultsPatch({ audioLangs: list.length ? list : undefined }),
      });
    }
    const subsRoot = $('setDefaultSubs');
    if (subsRoot) {
      subsPicker = createLangPicker(subsRoot, {
        onChange: list => saveDefaultsPatch({ subLangs: list.length ? list : undefined }),
      });
    }

    $('setEmbedSubs')?.addEventListener('change', async e => {
      await saveDefaultsPatch({ embedSubs: e.target.checked ? undefined : false });
      syncFormFromState();
    });
    $('setKeepSrt')?.addEventListener('change', e => saveDefaultsPatch({ keepSrt: e.target.checked ? undefined : false }));

    $('clearMemoryBtn')?.addEventListener('click', async () => {
      const next = await saveUiSettings({ siteMemory: {} });
      setUi(next);
      renderMemory();
      onUiChanged?.();
    });

    $('setMotion')?.addEventListener('change', async e => {
      const motion = e.target.value;
      const next = await saveUiSettings({ motion });
      setUi(next);
      onUiChanged?.();
    });

    // The page button reads this setting itself (content/overlay.js) and shows or hides at once.
    $('setOverlay')?.addEventListener('change', async e => {
      setUi(await saveUiSettings({ overlay: Boolean(e.target.checked) }));
    });

    $('setNotify')?.addEventListener('change', async e => {
      const el = e.target;
      try {
        const saved = await api('POST', '/settings', { notify: el.value });
        setSettings(saved);
      } catch {
        // Helper offline: show the value the helper still has, not the one that was not saved.
        el.value = ['all', 'errors', 'off'].includes(getSettings()?.notify) ? getSettings().notify : 'all';
      }
    });

    $('pickOutDir')?.prepend(icon('folder'));
    $('pickOutDir')?.addEventListener('click', pickOutDir);
    $('outDir')?.addEventListener('click', e => {
      if (e.currentTarget.readOnly) pickOutDir();
    });
    $('outDir')?.addEventListener('change', e => {
      if (!e.target.readOnly && e.target.value.trim()) saveOutDir(e.target.value.trim());
    });

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
    selectTab(readTab());
    syncFormFromState();
  }

  async function open() {
    selectTab(readTab());
    syncFormFromState();
    // The page view loads these too, but only after a page scan; settings may open first.
    api('GET', '/settings').then(s => {
      setSettings(s);
      syncFormFromState();
    }).catch(() => {});
    await reposView.refresh();
  }

  function refreshI18n() {
    syncFormFromState();
    reposView.refresh();
  }

  return { wire, open, refreshI18n };
}
