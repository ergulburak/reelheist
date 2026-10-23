// Site repositories and packs management UI in Settings (spec §5d.4).
import { t } from '../lib/i18n.js';
import { saveUiSettings } from '../lib/ui-settings.js';

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

export function createReposView({ bg, getUi, setUi, errText, onPacksChanged }) {
  const $ = id => document.getElementById(id);

  let repos = [];
  let installed = [];
  let availableByRepo = new Map();

  function setStatus(msg, isError = false) {
    const el = $('repoStatus');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('err', isError);
    el.hidden = !msg;
  }

  async function refresh() {
    try {
      const base = await bg({ type: 'packs-list' });
      repos = base?.repos || [];
      installed = base?.installed || [];
      availableByRepo = new Map();
      for (const r of repos) {
        if (!r.trusted) continue;
        try {
          const sub = await bg({ type: 'packs-list', url: r.url });
          availableByRepo.set(r.url, sub?.available || []);
        } catch (e) {
          setStatus(errText(e), true);
        }
      }
      renderRepos();
      renderPacks();
      const autoEl = $('autoUpdatePacks');
      if (autoEl) autoEl.checked = getUi().autoUpdatePacks !== false;
    } catch (e) {
      setStatus(errText(e), true);
    }
  }

  function renderRepos() {
    const box = $('reposList');
    if (!box) return;
    const rows = repos.map(repo => {
      const titleLine = h('div', { class: 'repo-head' },
        h('div', { class: 'repo-title' },
          h('strong', {}, repo.name),
          h('small', { class: 'muted' }, repo.url),
        ),
        h('button', {
          type: 'button',
          class: 'btn-remove-repo',
          'data-repo-url': repo.url,
          onclick: async () => {
            setStatus('');
            try {
              await bg({ type: 'packs-remove-repo', url: repo.url });
              await refresh();
              onPacksChanged?.();
            } catch (e) {
              setStatus(errText(e), true);
            }
          },
        }, t('btn_remove_repo')),
      );

      if (!repo.trusted) {
        const trustPrompt = h('div', { class: 'repo-trust' },
          h('div', { class: 'repo-fp' }, t('repo_trust_prompt', { fp: repo.fingerprint })),
          h('button', {
            type: 'button',
            class: 'btn-trust-repo primary',
            'data-repo-url': repo.url,
            onclick: async () => {
              setStatus('');
              try {
                await bg({ type: 'packs-trust-repo', url: repo.url });
                await refresh();
              } catch (e) {
                setStatus(errText(e), true);
              }
            },
          }, t('btn_trust_repo')),
        );
        return h('div', { class: 'repo-card untrusted' }, titleLine, trustPrompt);
      }

      return h('div', { class: 'repo-card trusted' },
        titleLine,
        h('div', { class: 'muted small repo-fp' }, repo.fingerprint),
      );
    });
    box.replaceChildren(...rows);
  }

  function renderPacks() {
    const wrap = $('packsSection');
    const listEl = $('packsList');
    if (!wrap || !listEl) return;

    const hasTrusted = repos.some(r => r.trusted);
    wrap.hidden = !hasTrusted && !installed.length;
    if (wrap.hidden) return;

    const q = ($('packSearchInput')?.value || '').trim().toLowerCase();
    const installedById = new Map(installed.map(p => [p.id, p]));
    const items = [];
    const seen = new Set();

    for (const r of repos) {
      if (!r.trusted) continue;
      for (const entry of availableByRepo.get(r.url) || []) {
        seen.add(entry.id);
        items.push({
          id: entry.id,
          name: entry.name || entry.id,
          version: entry.version || '',
          hosts: entry.hosts || [],
          repoUrl: r.url,
          isInstalled: installedById.has(entry.id),
        });
      }
    }
    for (const p of installed) {
      if (seen.has(p.id)) continue;
      items.push({
        id: p.id,
        name: p.name || p.id,
        version: p.version || '',
        hosts: p.hosts || [],
        repoUrl: '',
        isInstalled: true,
      });
    }

    const filtered = items.filter(it => {
      if (!q) return true;
      const hay = `${it.id} ${it.name} ${it.hosts.join(' ')}`.toLowerCase();
      return hay.includes(q);
    });

    const cards = filtered.map(it => {
      const metaText = [it.version ? `v${it.version}` : '', it.hosts.join(', ')].filter(Boolean).join(' · ');
      const actionBtn = it.isInstalled
        ? h('button', {
            type: 'button',
            class: 'btn-uninstall-pack',
            'data-pack-id': it.id,
            onclick: async () => {
              setStatus('');
              try {
                await bg({ type: 'packs-uninstall', id: it.id });
                await refresh();
                onPacksChanged?.();
              } catch (e) {
                setStatus(errText(e), true);
              }
            },
          }, t('btn_uninstall_pack'))
        : h('button', {
            type: 'button',
            class: 'btn-install-pack',
            'data-repo-url': it.repoUrl,
            'data-pack-id': it.id,
            onclick: async () => {
              setStatus('');
              try {
                await bg({ type: 'packs-install', url: it.repoUrl, id: it.id });
                await refresh();
                onPacksChanged?.();
              } catch (e) {
                setStatus(errText(e), true);
              }
            },
          }, t('btn_install_pack'));

      return h('div', { class: 'pack-row' },
        h('div', { class: 'pack-info' },
          h('div', { class: 'pack-name' }, it.name),
          h('div', { class: 'muted small' }, metaText),
        ),
        actionBtn,
      );
    });

    listEl.replaceChildren(...cards);
  }

  async function addRepoFromInput() {
    const input = $('repoUrlInput');
    const url = input?.value?.trim();
    if (!url) return;
    setStatus('');
    try {
      await bg({ type: 'packs-add-repo', url });
      input.value = '';
      await refresh();
    } catch (e) {
      setStatus(errText(e), true);
    }
  }

  function wire() {
    $('addRepoBtn')?.addEventListener('click', addRepoFromInput);
    $('repoUrlInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addRepoFromInput();
      }
    });
    $('packSearchInput')?.addEventListener('input', () => renderPacks());
    $('updatePacksBtn')?.addEventListener('click', async () => {
      setStatus('');
      try {
        const res = await bg({ type: 'packs-update' });
        setStatus(t('packs_updated', { n: (res?.updated || []).length }), false);
        await refresh();
        if (res?.updated?.length) onPacksChanged?.();
      } catch (e) {
        setStatus(errText(e), true);
      }
    });
    $('autoUpdatePacks')?.addEventListener('change', async e => {
      const next = await saveUiSettings({ autoUpdatePacks: Boolean(e.target.checked) });
      setUi(next);
    });
  }

  return { wire, refresh };
}
