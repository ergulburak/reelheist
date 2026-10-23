// YouTube pages: which URL to hand to yt-dlp, and the login cookies it may need.

// Returns {videoUrl, playlistUrl} or null when the page is not a video/playlist page.
export function youtubeTarget(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return id ? { videoUrl: `https://www.youtube.com/watch?v=${id}`, playlistUrl: null } : null;
  }
  if (host !== 'youtube.com') return null;
  const list = u.searchParams.get('list');
  const playlistUrl = list && !/^(RD|UL|LL$|WL$)/.test(list) ? `https://www.youtube.com/playlist?list=${list}` : null;
  if (u.pathname === '/watch' && u.searchParams.get('v')) {
    return { videoUrl: `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`, playlistUrl };
  }
  const shorts = /^\/(shorts|live)\/([\w-]{6,})/.exec(u.pathname);
  if (shorts) return { videoUrl: `https://www.youtube.com/watch?v=${shorts[2]}`, playlistUrl: null };
  if (u.pathname === '/playlist' && playlistUrl) return { videoUrl: null, playlistUrl };
  return null;
}

// Netscape cookies.txt for yt-dlp (age-restricted videos, "confirm you are not a bot").
export async function youtubeCookies() {
  if (!chrome.cookies) return '';
  const all = await chrome.cookies.getAll({ domain: 'youtube.com' });
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of all) {
    const domain = c.domain.startsWith('.') || !c.hostOnly ? (c.domain.startsWith('.') ? c.domain : `.${c.domain}`) : c.domain;
    lines.push([
      domain,
      domain.startsWith('.') ? 'TRUE' : 'FALSE',
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      c.expirationDate ? Math.round(c.expirationDate) : 0,
      c.name,
      c.value,
    ].join('\t'));
  }
  return lines.length > 1 ? lines.join('\n') + '\n' : '';
}
