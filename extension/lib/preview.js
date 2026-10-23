// Preview clip client: ask the helper for a 2-second silent clip and return it as a blob: URL.
// A <video src> cannot send the X-Token header, so the clip is fetched here and wrapped in a blob.

import { api, getHelper } from './helper.js';

const WAIT_MS = 4000;
const POLL_MS = 300;

// settings.motion: 'auto' | 'on' | 'off'. In 'auto', follow the system reduced-motion setting.
export function wantsClip(motion = 'auto', matchMediaFn = globalThis.matchMedia?.bind(globalThis)) {
  if (motion === 'off') return false;
  if (motion === 'on') return true;
  return !(matchMediaFn && matchMediaFn('(prefers-reduced-motion: reduce)').matches);
}

// Still image shown first: YouTube thumbnail, else the page's og:image. null when there is none.
export function staticFrameUrl({ youtubeUrl, ogImage, pageUrl } = {}) {
  if (youtubeUrl) {
    try {
      const id = new URL(youtubeUrl).searchParams.get('v');
      if (id) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    } catch { /* not a URL */ }
  }
  if (ogImage) {
    try {
      const u = new URL(ogImage, pageUrl || undefined);
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
    } catch { /* relative URL without a page */ }
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// -> blob: URL of the clip, or null when it is not ready within 4 s or anything fails.
export async function loadPreview(source, { kind, playlists, headers, pageUrl } = {}) {
  const deadline = Date.now() + WAIT_MS;
  try {
    const { id } = await api('POST', '/preview', { url: source, kind, playlists, headers, pageUrl });
    while (Date.now() < deadline) {
      const h = await getHelper();
      const res = await fetch(`http://127.0.0.1:${h.port}/api/preview/${id}`, {
        headers: { 'X-Token': h.token },
        signal: AbortSignal.timeout(Math.max(500, deadline - Date.now())),
      });
      if (res.status === 200) return URL.createObjectURL(await res.blob());
      if (res.status !== 202) return null;
      await sleep(POLL_MS);
    }
  } catch { /* the static frame stays */ }
  return null;
}
