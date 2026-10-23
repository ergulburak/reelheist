// Site pack validator. Pure ES module, no browser globals (used by Node tools and the service worker).

export const MAX_PACK_BYTES = 64 * 1024;
export const MAX_BLOCK_RULES = 20;
const MAX_LIST = 50;
const MAX_STR = 1000;

const TOP = ['schema', 'id', 'name', 'version', 'lang', 'hosts', 'title', 'episodes', 'player', 'block'];
const TITLE = ['strip', 'episodeUrl', 'slugUrl', 'yearUrl'];
const EPISODES = ['linkUrl'];
const PLAYER = ['lazySrcAttrs', 'playSelectors', 'frameFetch'];
const BLOCK_RULE = ['urlFilter', 'action'];
const ACTIONS = ['stub', 'block'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_STR;

function unknownKeys(obj, allowed, path, errors) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${path ? path + '.' : ''}${k}: unknown field`);
  }
}

// Checks one regex string; `groups` lists named groups it must contain.
function checkRegex(value, path, groups, errors) {
  if (!isStr(value)) { errors.push(`${path}: must be a non-empty string`); return; }
  try { new RegExp(value, 'i'); } catch { errors.push(`${path}: invalid regex`); return; }
  for (const g of groups) {
    if (!value.includes(`(?<${g}>`)) errors.push(`${path}: missing named group (?<${g}>)`);
  }
}

function checkList(value, path, errors, each) {
  if (!Array.isArray(value)) { errors.push(`${path}: must be an array`); return; }
  if (value.length > MAX_LIST) errors.push(`${path}: at most ${MAX_LIST} entries`);
  value.forEach((v, i) => each(v, `${path}[${i}]`));
}

function checkHost(v, path, errors) {
  if (!isStr(v)) { errors.push(`${path}: must be a non-empty string`); return; }
  if (/[/:\s]/.test(v)) errors.push(`${path}: must be a bare hostname pattern (no scheme, path, port or spaces)`);
  else if (!/^[a-z0-9*.-]+$/.test(v)) errors.push(`${path}: only lowercase letters, digits, "-", "." and "*" allowed`);
}

export function validatePack(obj) {
  const errors = [];
  if (!isObj(obj)) return { ok: false, errors: ['pack: must be an object'] };

  let size = Infinity;
  try { size = new TextEncoder().encode(JSON.stringify(obj)).length; } catch { /* not serializable */ }
  if (size > MAX_PACK_BYTES) errors.push('pack: larger than 64 KB');

  unknownKeys(obj, TOP, '', errors);
  if (obj.schema !== 1) errors.push('schema: must be 1');
  if (typeof obj.id !== 'string' || !/^[a-z0-9-]{2,40}$/.test(obj.id)) errors.push('id: must match /^[a-z0-9-]{2,40}$/');
  if (!isStr(obj.name)) errors.push('name: must be a non-empty string');
  if (typeof obj.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(obj.version)) errors.push('version: must look like x.y.z');
  if (obj.lang !== undefined && !isStr(obj.lang)) errors.push('lang: must be a non-empty string');

  if (!Array.isArray(obj.hosts) || obj.hosts.length === 0) errors.push('hosts: must be a non-empty array');
  else checkList(obj.hosts, 'hosts', errors, (v, p) => checkHost(v, p, errors));

  const epGroups = ['season', 'episode'];
  if (obj.title !== undefined) {
    if (!isObj(obj.title)) errors.push('title: must be an object');
    else {
      const t = obj.title;
      unknownKeys(t, TITLE, 'title', errors);
      if (t.strip !== undefined) checkList(t.strip, 'title.strip', errors, (v, p) => checkRegex(v, p, [], errors));
      if (t.episodeUrl !== undefined) checkList(t.episodeUrl, 'title.episodeUrl', errors, (v, p) => checkRegex(v, p, epGroups, errors));
      if (t.slugUrl !== undefined) checkRegex(t.slugUrl, 'title.slugUrl', ['slug'], errors);
      if (t.yearUrl !== undefined) checkRegex(t.yearUrl, 'title.yearUrl', [], errors);
    }
  }

  if (obj.episodes !== undefined) {
    if (!isObj(obj.episodes)) errors.push('episodes: must be an object');
    else {
      unknownKeys(obj.episodes, EPISODES, 'episodes', errors);
      if (obj.episodes.linkUrl !== undefined) {
        checkList(obj.episodes.linkUrl, 'episodes.linkUrl', errors, (v, p) => checkRegex(v, p, epGroups, errors));
      }
    }
  }

  if (obj.player !== undefined) {
    if (!isObj(obj.player)) errors.push('player: must be an object');
    else {
      const p = obj.player;
      unknownKeys(p, PLAYER, 'player', errors);
      const str = (v, path) => { if (!isStr(v)) errors.push(`${path}: must be a non-empty string`); };
      if (p.lazySrcAttrs !== undefined) {
        checkList(p.lazySrcAttrs, 'player.lazySrcAttrs', errors, (v, path) => {
          if (!isStr(v) || !/^[a-zA-Z][\w:.-]*$/.test(v)) errors.push(`${path}: must be an attribute name`);
        });
      }
      if (p.playSelectors !== undefined) {
        checkList(p.playSelectors, 'player.playSelectors', errors, str);
      }
      if (p.frameFetch !== undefined && typeof p.frameFetch !== 'boolean') errors.push('player.frameFetch: must be a boolean');
    }
  }

  if (obj.block !== undefined) {
    if (!Array.isArray(obj.block)) errors.push('block: must be an array');
    else {
      if (obj.block.length > MAX_BLOCK_RULES) errors.push(`block: at most ${MAX_BLOCK_RULES} rules`);
      obj.block.forEach((r, i) => {
        const path = `block[${i}]`;
        if (!isObj(r)) { errors.push(`${path}: must be an object`); return; }
        unknownKeys(r, BLOCK_RULE, path, errors);
        if (!isStr(r.urlFilter)) errors.push(`${path}.urlFilter: must be a non-empty string`);
        if (!ACTIONS.includes(r.action)) errors.push(`${path}.action: must be "stub" or "block"`);
      });
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, errors, pack: obj };
}
