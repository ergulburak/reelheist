// SVG icons built via DOM nodes (no innerHTML, safe under CSP / Trusted Types).
// Icon names: hd, speaker, cc, download, tray, gear, back, folder, play, pause, close, trash, retry, film, check.

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, children = []) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'textContent') el.textContent = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) el.appendChild(c);
  return el;
}

export const ICONS = {
  hd: () => [
    svgEl('rect', { x: 2, y: 5, width: 20, height: 14, rx: 3, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }),
    svgEl('text', {
      x: 12,
      y: 15.5,
      'font-size': 8,
      'font-family': 'Segoe UI, sans-serif',
      'font-weight': 700,
      'text-anchor': 'middle',
      fill: 'currentColor',
      textContent: 'HD',
    }),
  ],
  speaker: () => [
    svgEl('path', { d: 'M4 9v6h4l5 4V5L8 9H4z', fill: 'currentColor' }),
    svgEl('path', {
      d: 'M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.8,
      'stroke-linecap': 'round',
    }),
  ],
  cc: () => [
    svgEl('rect', { x: 2, y: 5, width: 20, height: 14, rx: 3, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }),
    svgEl('path', {
      d: 'M10.5 10.2a2.3 2.3 0 1 0 0 3.6M17 10.2a2.3 2.3 0 1 0 0 3.6',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.8,
      'stroke-linecap': 'round',
    }),
  ],
  download: () => [
    svgEl('path', {
      d: 'M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2.2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  ],
  tray: () => [
    svgEl('path', {
      d: 'M12 3v9m0 0-3.5-3.5M12 12l3.5-3.5',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
    svgEl('path', {
      d: 'M3 14h5l1.5 2.5h5L16 14h5v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linejoin': 'round',
    }),
  ],
  gear: () => [
    svgEl('circle', { cx: 12, cy: 12, r: 3.2, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }),
    svgEl('path', {
      d: 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
    }),
  ],
  back: () => [
    svgEl('path', {
      d: 'M15 5l-7 7 7 7',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2.2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  ],
  folder: () => [
    svgEl('path', {
      d: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linejoin': 'round',
    }),
  ],
  play: () => [
    svgEl('path', { d: 'M7 5v14l12-7z', fill: 'currentColor' }),
  ],
  pause: () => [
    svgEl('rect', { x: 6.5, y: 5, width: 3.8, height: 14, rx: 1.2, fill: 'currentColor' }),
    svgEl('rect', { x: 13.7, y: 5, width: 3.8, height: 14, rx: 1.2, fill: 'currentColor' }),
  ],
  close: () => [
    svgEl('path', {
      d: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2.2,
      'stroke-linecap': 'round',
    }),
  ],
  trash: () => [
    svgEl('path', {
      d: 'M4.5 7h15M10 4h4M6.5 7l.9 11.2a2 2 0 0 0 2 1.8h5.2a2 2 0 0 0 2-1.8L17.5 7M10.2 11v5M13.8 11v5',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  ],
  retry: () => [
    svgEl('path', {
      d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v3.8h-3.8',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2.2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  ],
  film: () => [
    svgEl('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 }),
    svgEl('path', { d: 'M10 9.2v5.6l4.8-2.8z', fill: 'currentColor' }),
  ],
  check: () => [
    svgEl('path', {
      d: 'M5 12.5l4.5 4.5L19 7.5',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2.4,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  ],
};

export function icon(name, className = 'ico') {
  const build = ICONS[name];
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24',
    class: `${className} ico-${name}`,
    'aria-hidden': 'true',
  }, build ? build() : []);
  return svg;
}
