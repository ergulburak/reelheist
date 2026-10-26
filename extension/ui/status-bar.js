// Bottom status bar shown across all popup screens.
import { t } from '../lib/i18n.js';
import { icon } from './icons.js';
import { queueSummary } from '../lib/queue-summary.js';

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
    // Several jobs run at once with parallel downloads: then the bar gives their number and mean percent.
    const s = queueSummary(jobs || []);
    if (s.first) {
      const pct = s.pct;
      const extra = s.waiting ? `+${s.waiting} ›` : '›';
      const title = s.running.length > 1
        ? t('status_bar_downloading_n', { n: s.running.length })
        : t('status_bar_downloading', { name: s.first.names?.base || 'Video' });
      bar.replaceChildren(
        icon('tray'),
        h('span', { class: 'foot-title' }, title),
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
