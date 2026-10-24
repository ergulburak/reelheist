'use strict';
// HTTP helpers on top of Node's built-in fetch, with retries and caller-supplied headers.

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Headers the browser sent for the original request; we replay the ones servers check.
function pickHeaders(h = {}) {
  const out = { 'User-Agent': DEFAULT_UA, Accept: '*/*' };
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (!v) continue;
    if (key === 'referer') out.Referer = v;
    else if (key === 'origin') out.Origin = v;
    else if (key === 'user-agent') out['User-Agent'] = v;
    else if (key === 'cookie') out.Cookie = v;
    else if (key === 'authorization') out.Authorization = v;
  }
  return out;
}

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.status = status;
    this.url = url;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Body read chunk by chunk; `arm` restarts the idle timer, so a slow but live download
// never hits the timeout, only a stalled one does.
async function readBody(res, arm) {
  const chunks = [];
  const reader = res.body.getReader();
  for (;;) {
    arm();
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// timeoutMs: idle limit (no headers or no body bytes for that long), not a total limit.
async function request(url, { headers, signal, range, timeoutMs = 30000, retries = 5 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    };
    arm();
    try {
      const h = pickHeaders(headers);
      if (range) h.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
      const res = await fetch(url, { headers: h, signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok) {
        // 4xx (except 408/429) will not get better with retries.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          throw Object.assign(new HttpError(res.status, url), { fatal: true });
        }
        throw new HttpError(res.status, url);
      }
      const buf = await readBody(res, arm);
      return { buf, res };
    } catch (e) {
      lastErr = e;
      if (e.fatal || signal?.aborted) throw e;
      await sleep(Math.min(1000 * 2 ** attempt, 15000));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;
}

// opts.cache: {url: text} playlists the browser already fetched (servers behind
// Cloudflare answer only the browser, not us).
async function getText(url, opts = {}) {
  if (opts.cache && typeof opts.cache[url] === 'string') {
    return { text: opts.cache[url], finalUrl: url, contentType: '' };
  }
  const { buf, res } = await request(url, opts);
  return { text: buf.toString('utf8'), finalUrl: res.url || url, contentType: res.headers.get('content-type') || '' };
}

module.exports = { request, getText, pickHeaders, HttpError, DEFAULT_UA };
