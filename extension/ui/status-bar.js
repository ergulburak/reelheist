// Bottom status bar shown across all popup screens.
import { t } from '../lib/i18n.js';
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

export function createStatusBar({ onClick }) {
  const $ = id => document.getElementById(id);
  let updateInfo = null; // { available, latest, url }

  function wire() {
    $('statusBar')?.addEventListener('click', () => onClick?.());
  }

  function setUpdateInfo(info) {
    updateInfo = info;
  }

  function render(jobs = []) {
    const bar = $('statusBar');
    if (!bar) return;
    const active = (jobs || []).filter(j => ['downloading', 'muxing', 'queued'].includes(j.state));
    const running = active.find(j => j.state === 'downloading' || j.state === 'muxing') || active[0];
    if (running) {
      const pct = Math.round(running.progress?.percent || 0);
      const extra = active.length > 1 ? `+${active.length - 1} ›` : '›';
      bar.replaceChildren(
        icon('tray'),
        h('span', { class: 'foot-title' }, t('status_bar_downloading', { name: running.names?.base || 'Video' })),
        h('span', { class: 'bar' }, h('i', { style: `width:${pct}%` })),
        h('span', {}, t('percent', { n: pct })),
        h('span', { class: 'hint-link accent' }, extra),
      );
      return;
    }
    const lastDone = [...(jobs || [])].reverse().find(j => j.state === 'done');
    const subText = updateInfo?.available
      ? `${t('update_available', { v: updateInfo.latest })} ›`
      : (lastDone ? `${lastDone.names?.base || ''} ›` : '›');
    bar.replaceChildren(
      icon('tray'),
      h('span', { class: 'foot-title' }, t('status_bar_downloads')),
      h('span', { class: `foot-sub${updateInfo?.available ? ' accent' : ''}` }, subText),
    );
  }

  return { wire, render, setUpdateInfo };
}
