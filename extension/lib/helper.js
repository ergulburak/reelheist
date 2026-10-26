// Connection to the local helper: native messaging gives {port, token}, then plain HTTP.

const HOST = 'com.reelheist.helper';
let cached = null;

async function ping(h) {
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/ping`, {
      headers: { 'X-Token': h.token },
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function getHelper(force = false) {
  if (!force) {
    if (!cached) cached = (await chrome.storage.session.get('helper')).helper || null;
    if (cached && (await ping(cached))) return cached;
  }
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(HOST, { cmd: 'hello' });
  } catch (e) {
    const err = new Error('The helper program was not found (native host is not registered)');
    err.code = 'helper_missing';
    err.detail = e.message;
    throw err;
  }
  if (!reply?.ok) throw Object.assign(new Error(reply?.error || 'The helper program did not answer'), { code: 'helper_no_reply' });
  cached = { port: reply.port, token: reply.token, version: reply.version };
  await chrome.storage.session.set({ helper: cached });
  return cached;
}

// An older helper has the same version number but not every feature: it answers ping
// without `features`, or without the name. Throws helper_outdated in that case.
export async function requireFeature(name) {
  const info = await api('GET', '/ping');
  if (!Array.isArray(info?.features) || !info.features.includes(name)) {
    throw Object.assign(new Error(`The helper program is out of date (no "${name}" support)`), { code: 'helper_outdated' });
  }
}

export async function api(method, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const h = await getHelper(attempt > 0);
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${h.port}/api${path}`, {
        method,
        headers: { 'X-Token': h.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (attempt === 0) continue; // daemon restarted: get a fresh port/token
      throw e;
    }
    if (res.status === 401 && attempt === 0) continue;
    const data = await res.json().catch(() => ({}));
    // Daemon errors are { error: <code>, detail }; the UI maps the code to err_<code>.
    if (!res.ok) throw Object.assign(new Error(data.detail || data.error || `HTTP ${res.status}`), { code: data.error });
    return data;
  }
  throw Object.assign(new Error('Could not connect to the helper program'), { code: 'helper_unreachable' });
}
