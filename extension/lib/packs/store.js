// Site pack repository management. Pure ES module: storage and fetch are injected.
import { validatePack } from './schema.js';
import { sha256Hex, fingerprint, verifyPack } from './verify.js';

function fail(code, message, extra) {
  return Object.assign(new Error(message || code), { code }, extra);
}

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

// `*` matches one or more characters inside a single label (never "." or "/").
export function matchHost(pattern, hostname) {
  if (typeof pattern !== 'string' || typeof hostname !== 'string') return false;
  const re = pattern.split('*').map(escapeRe).join('[^./]+');
  return new RegExp(`^${re}$`, 'i').test(hostname);
}

// Over-broad patterns: last label must be literal, earlier labels need a literal character.
function broadHostError(pattern) {
  const labels = pattern.split('.');
  if (labels.length < 2) return 'must have at least two labels';
  if (labels[labels.length - 1].includes('*')) return 'last label must not contain "*"';
  if (labels.slice(0, -1).join('').replace(/\*/g, '') === '') return 'the labels before the last need a literal character';
  return null;
}

export function normalizeRepoUrl(input) {
  let s = String(input ?? '').trim();
  s = s.replace(/\/(repo|index)\.json$/, '').replace(/\/+$/, '');
  let u;
  try { u = new URL(s); } catch { throw fail('repo_invalid', 'Repository URL is not valid'); }
  const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  if (u.protocol !== 'https:' && !local) throw fail('repo_invalid', 'Repository URL must use https');
  if (u.search || u.hash) throw fail('repo_invalid', 'Repository URL must not have a query or fragment');
  return s;
}

const cmpVersion = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

export function createStore({ storage, fetch }) {
  let queue = Promise.resolve();
  // Serializes read-modify-write cycles so parallel messages cannot lose updates.
  const mutate = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  const read = async (key, fallback) => (await storage.get(key))[key] ?? fallback;

  async function getBytes(url, { notFoundCode = 'repo_unreachable' } = {}) {
    let res;
    try { res = await fetch(url); } catch { throw fail('repo_unreachable', `Cannot reach ${url}`); }
    if (!res.ok) throw fail(res.status === 404 ? notFoundCode : 'repo_unreachable', `HTTP ${res.status} for ${url}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async function getJson(url) {
    const bytes = await getBytes(url);
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw fail('repo_invalid', `Not valid JSON: ${url}`); }
  }

  async function findRepo(url) {
    const root = normalizeRepoUrl(url);
    const repo = (await read('packRepos', [])).find((r) => r.url === root);
    if (!repo) throw fail('repo_invalid', 'Repository is not added');
    return repo;
  }

  async function addRepo(url) {
    const root = normalizeRepoUrl(url);
    const meta = await getJson(`${root}/repo.json`);
    if (!meta || meta.schema !== 1 || typeof meta.name !== 'string' || !meta.name || typeof meta.publicKey !== 'string') {
      throw fail('repo_invalid', 'repo.json is malformed');
    }
    let fp;
    try { fp = await fingerprint(meta.publicKey); } catch { throw fail('repo_invalid', 'Repository public key is not valid'); }
    return mutate(async () => {
      const repos = await read('packRepos', []);
      const old = repos.find((r) => r.url === root);
      // Keep trust only while the key stays the same.
      const trusted = !!old && old.trusted && old.publicKey === meta.publicKey;
      const entry = { url: root, name: meta.name, fingerprint: fp, trusted, publicKey: meta.publicKey };
      await storage.set({ packRepos: [...repos.filter((r) => r.url !== root), entry] });
      return { url: root, name: meta.name, fingerprint: fp, trusted };
    });
  }

  const trustRepo = (url) => mutate(async () => {
    const root = normalizeRepoUrl(url);
    const repos = await read('packRepos', []);
    const repo = repos.find((r) => r.url === root);
    if (!repo) throw fail('repo_invalid', 'Repository is not added');
    repo.trusted = true;
    await storage.set({ packRepos: repos });
    return { url: root, name: repo.name, fingerprint: repo.fingerprint, trusted: true };
  });

  async function dropPacks(installed, ids) {
    const preferred = await read('preferredPack', {});
    for (const id of ids) delete installed[id];
    for (const h of Object.keys(preferred)) if (ids.includes(preferred[h])) delete preferred[h];
    await storage.set({ installedPacks: installed, preferredPack: preferred });
  }

  const removeRepo = (url) => mutate(async () => {
    const root = normalizeRepoUrl(url);
    const repos = await read('packRepos', []);
    const installed = await read('installedPacks', {});
    const ids = Object.keys(installed).filter((id) => installed[id].repoUrl === root);
    await dropPacks(installed, ids);
    await storage.set({ packRepos: repos.filter((r) => r.url !== root) });
    return { ok: true };
  });

  async function readIndex(root) {
    const idx = await getJson(`${root}/index.json`);
    if (!idx || idx.schema !== 1 || !Array.isArray(idx.packs)) throw fail('repo_invalid', 'index.json is malformed');
    return idx.packs;
  }

  async function listAvailable(url) {
    return readIndex(normalizeRepoUrl(url));
  }

  async function installFrom(repo, id, entries) {
    if (!repo.trusted) throw fail('repo_untrusted', 'Repository is not trusted');
    const entry = entries.find((e) => e && e.id === id);
    if (!entry || typeof entry.file !== 'string') throw fail('pack_not_found', `Pack not found: ${id}`);
    const fileUrl = new URL(entry.file, `${repo.url}/`).href;
    const bytes = await getBytes(fileUrl);
    if ((await sha256Hex(bytes)) !== String(entry.sha256).toLowerCase()) throw fail('pack_hash', 'Pack hash does not match the index');
    const sig = new TextDecoder().decode(await getBytes(`${fileUrl}.sig`, { notFoundCode: 'pack_signature' }));
    if (!(await verifyPack(bytes, sig, repo.publicKey))) throw fail('pack_signature', 'Pack signature is not valid');
    let obj;
    try { obj = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw fail('pack_invalid', 'Pack is not valid JSON', { errors: ['pack: not valid JSON'] }); }
    const v = validatePack(obj);
    const errors = [...v.errors];
    if (v.ok) {
      if (obj.id !== id) errors.push('id: does not match the index entry');
      obj.hosts.forEach((h, i) => { const m = broadHostError(h); if (m) errors.push(`hosts[${i}]: ${m}`); });
    }
    if (errors.length) throw fail('pack_invalid', errors[0], { errors });
    await mutate(async () => {
      const installed = await read('installedPacks', {});
      installed[id] = { pack: obj, repoUrl: repo.url, version: obj.version, installedAt: installed[id]?.installedAt ?? Date.now() };
      await storage.set({ installedPacks: installed });
    });
    return obj;
  }

  async function installPack(url, id) {
    const repo = await findRepo(url);
    if (!repo.trusted) throw fail('repo_untrusted', 'Repository is not trusted');
    return installFrom(repo, id, await readIndex(repo.url));
  }

  const uninstallPack = (id) => mutate(async () => {
    await dropPacks(await read('installedPacks', {}), [id]);
    return { ok: true };
  });

  async function installedPacks() {
    return Object.values(await read('installedPacks', {})).map((e) => e.pack);
  }

  async function updateAll() {
    const result = { updated: [], failed: [] };
    const installed = await read('installedPacks', {});
    const repos = await read('packRepos', []);
    const indexes = new Map();
    for (const [id, rec] of Object.entries(installed)) {
      try {
        const repo = repos.find((r) => r.url === rec.repoUrl);
        if (!repo) throw fail('repo_invalid', 'Repository was removed');
        if (!indexes.has(repo.url)) indexes.set(repo.url, readIndex(repo.url));
        const entries = await indexes.get(repo.url);
        const entry = entries.find((e) => e && e.id === id);
        if (!entry) throw fail('pack_not_found', `Pack not found: ${id}`);
        if (typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(entry.version)) throw fail('pack_invalid', 'Index version is not valid');
        if (cmpVersion(entry.version, rec.version) <= 0) continue;
        await installFrom(repo, id, entries);
        result.updated.push(id);
      } catch (e) {
        result.failed.push({ id, code: e.code || 'repo_unreachable' });
      }
    }
    return result;
  }

  async function packForUrl(url) {
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
    const matches = Object.values(await read('installedPacks', {}))
      .filter((r) => r.pack.hosts.some((p) => matchHost(p, host)))
      .sort((a, b) => a.installedAt - b.installedAt);
    if (!matches.length) return null;
    const pref = (await read('preferredPack', {}))[host];
    return (matches.find((r) => r.pack.id === pref) || matches[0]).pack;
  }

  async function listRepos() {
    return (await read('packRepos', [])).map(({ url, name, fingerprint: fp, trusted }) => ({ url, name, fingerprint: fp, trusted }));
  }

  return { addRepo, trustRepo, removeRepo, listRepos, listAvailable, installPack, uninstallPack, installedPacks, updateAll, packForUrl };
}
