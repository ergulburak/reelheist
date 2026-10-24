// Site repositories and packs management UI in Settings (spec §5d.4).
import { t } from '../lib/i18n.js';
import { saveUiSettings } from '../lib/ui-settings.js';
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

// One readable host per pack: the first one without a wildcard, plus how many more there are.
function hostSummary(hosts) {
  const main = hosts.find(x => !x.includes('*')) || hosts[0] || '';
  const more = hosts.length - (main ? 1 : 0);
  return more > 0 ? `${main} +${more}` : main;
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
      const name = repo.name || repo.url;
      const row = h('div', { class: 'repo-row' },
        h('span', { class: 'repo-avatar', 'aria-hidden': 'true' }, name.trim().charAt(0).toUpperCase()),
        h('div', { class: 'repo-title' },
          h('strong', {}, name),
          h('small', { class: 'muted', title: repo.url }, repo.url),
        ),
        repo.trusted
          ? h('span', { class: 'repo-badge ok', title: repo.fingerprint }, t('repo_trusted'))
          : h('span', { class: 'repo-badge warn' }, t('repo_untrusted')),
        h('button', {
          type: 'button',
          class: 'iconbtn small-iconbtn btn-remove-repo',
          'data-repo-url': repo.url,
          title: t('btn_remove_repo'),
          'aria-label': t('btn_remove_repo'),
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
        }, icon('close')),
      );

      if (repo.trusted) return h('div', { class: 'repo-card trusted' }, row);

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
      return h('div', { class: 'repo-card untrusted' }, row, trustPrompt);
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

    const countEl = $('packsCount');
    if (countEl) countEl.textContent = t('packs_installed_count', { n: installed.length });

    // Installed packs first, then by name.
    const filtered = items
      .filter(it => {
        if (!q) return true;
        const hay = `${it.id} ${it.name} ${it.hosts.join(' ')}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => (b.isInstalled - a.isInstalled) || a.name.localeCompare(b.name));

    const rows = filtered.map(it => {
      const actionBtn = it.isInstalled
        ? h('button', {
            type: 'button',
            class: 'iconbtn small-iconbtn btn-uninstall-pack',
            'data-pack-id': it.id,
            title: t('btn_uninstall_pack'),
            'aria-label': `${t('btn_uninstall_pack')}: ${it.name}`,
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
          }, icon('close'))
        : h('button', {
            type: 'button',
            class: 'iconbtn small-iconbtn btn-install-pack',
            'data-repo-url': it.repoUrl,
            'data-pack-id': it.id,
            title: t('btn_install_pack'),
            'aria-label': `${t('btn_install_pack')}: ${it.name}`,
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
          }, icon('download'));

      return h('div', { class: `pack-row${it.isInstalled ? ' installed' : ''}`, role: 'row' },
        h('div', { class: 'pack-info', role: 'cell', title: it.hosts.join('\n') },
          h('div', { class: 'pack-name' }, it.name),
          h('div', { class: 'muted pack-host' }, hostSummary(it.hosts)),
        ),
        h('span', { class: 'muted pack-ver', role: 'cell' }, it.version),
        h('span', { role: 'cell' }, actionBtn),
      );
    });

    if (!rows.length) rows.push(h('div', { class: 'muted small packs-empty' }, t('packs_empty')));
    listEl.replaceChildren(...rows);
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
    $('updatePacksBtn')?.replaceChildren(icon('retry'));
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
