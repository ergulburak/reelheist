// "This page" view: preview card, selection chips, metadata editor, download/progress/exists/error states.
import { api, requireFeature } from '../lib/helper.js';
import { analyzeSources } from '../lib/sources.js';
import { youtubeTarget, youtubeCookies } from '../lib/youtube.js';
import { t, langTag, currentLang } from '../lib/i18n.js';
import { loadPreview, wantsClip, staticFrameUrl } from '../lib/preview.js';
import { chooseDefaults, rememberChoice, subtitleKey, embedSubsOption } from '../lib/defaults.js';
import { estimateBytes, estimateSeconds, formatBytes, formatDuration } from '../lib/estimate.js';
import { RELEASES_URL } from '../lib/links.js';
import { icon } from './icons.js';
import { createChipsController } from './chips.js';

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

export function sanitize(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '') || 'Video';
}

export function createPageView({ bg, getUi, getSettings, setSettings, errText, showView, onJobAdded }) {
  // Settings → Download → "Put subtitles inside the MP4": goes with every new job.
  const embedSubs = () => embedSubsOption(getUi(), currentLang());
  const $ = id => document.getElementById(id);

  let state = null;
  let analyzed = [];
  let yt = null;
  let pick = { height: null, audioLangs: 'all', subtitleKeys: [] };
  let avgSpeedBps = 5e6;
  let activeJob = null;
  let existing = null;
  let forceRedownload = false;
  let subsOnly = false; // "Subtitles only": no video, only the .srt files
  let existsSeq = 0;
  let existsTimer = null;
  let searchTimer = null;
  let promptTimer = null;
  let currentBlobUrl = null;

  const dur = sec => formatDuration(sec, currentLang());
  const bytes = n => formatBytes(n, currentLang());

  function pageHost() {
    try { return new URL(state?.page?.url).hostname; } catch { return ''; }
  }

  function current() {
    return analyzed[Number($('source')?.value) || 0];
  }

  function allSubs() {
    const cur = current();
    if (cur?.probe?.type === 'ytdlp') {
      return (cur.probe.subtitles || []).map(s => ({
        lang: s.lang,
        auto: s.auto,
        label: `${s.name || s.lang}${s.auto ? ` (${t('tag_auto')})` : ''}`,
        checked: pick.subtitleKeys.includes(subtitleKey(s)),
      }));
    }
    const list = [...(state?.subs || [])];
    for (const s of cur?.probe?.subtitles || []) {
      list.push({ url: s.url, label: s.name, lang: s.lang, headers: cur.source.headers, hls: true });
    }
    return list.map(s => ({ ...s, checked: pick.subtitleKeys.includes(subtitleKey(s)) }));
  }

  const chips = createChipsController({
    getCurrent: current,
    getPick: () => pick,
    getSubsList: allSubs,
    onQualityChange: () => {
      updateDownloadEstimate();
    },
    onSelectionChange: () => {
      updateDownloadEstimate();
    },
  });

  function setStatus(el, text, isError = false) {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('err', isError);
    el.hidden = !text;
  }

  function setViewState(mode, errorObj = null) {
    const status = $('pageStatus');
    $('searchingBox').hidden = mode !== 'searching';
    $('errorBox').hidden = mode !== 'error';
    $('noHelperBox').hidden = mode !== 'no-helper';

    if (mode === 'searching') {
      $('pageForm').hidden = true;
      setStatus(status, t('status_searching'), false);
    } else if (mode === 'no-helper') {
      $('pageForm').hidden = true;
      setStatus(status, errText(errorObj), true);
    } else if (mode === 'error') {
      $('pageForm').hidden = true;
      const msg = errText(errorObj);
      setStatus(status, msg, true);
      $('errorText').textContent = msg;
      const detail = errorObj?.detail || errorObj?.message || '';
      const hasDetail = Boolean(detail && detail !== msg);
      $('errorDetailsWrap').hidden = !hasDetail;
      $('errorDetail').textContent = hasDetail ? detail : '';
    } else if (mode === 'unsupported') {
      $('pageForm').hidden = true;
    } else if (mode === 'ready') {
      $('searchingBox').hidden = true;
      $('errorBox').hidden = true;
      $('noHelperBox').hidden = true;
      status?.classList.add('ready-sr');
      return;
    }
    status?.classList.remove('ready-sr');
  }

  function names() {
    const name = sanitize($('name').value);
    if ($('kind').value === 'video') return { folder: sanitize($('channel').value || 'YouTube'), base: name };
    if ($('kind').value === 'episode') {
      const p = n => String(Number(n) || 0).padStart(2, '0');
      // Same as the helper's names.js: every episode has its own folder (sub) in the series folder.
      const base = `${name}.S${p($('season').value)}E${p($('episode').value)}`;
      return { folder: name, base, sub: base };
    }
    const y = $('year').value;
    const withYear = y ? sanitize(`${name} (${y})`) : name;
    return { folder: withYear, base: withYear };
  }

  function updatePreviewHeader() {
    const cur = current();
    const kind = $('kind').value;
    const title = $('name').value.trim() || state?.meta?.name || 'ReelHeist';
    $('previewTitle').textContent = title;
    const d = cur?.probe?.duration ? dur(cur.probe.duration) : '';
    const parts = [];
    if (kind === 'episode') {
      const s = Number($('season').value);
      const e = Number($('episode').value);
      if (s) parts.push(t('season_n', { n: s }));
      if (e) parts.push(t('episode_n', { n: e }));
      if (d) parts.push(d);
    } else if (kind === 'movie') {
      const y = $('year').value;
      if (y) parts.push(String(y));
      if (d) parts.push(d);
    } else {
      const ch = $('channel').value.trim();
      if (ch) parts.push(ch);
      if (d) parts.push(d);
    }
    $('previewMeta').textContent = parts.join(' · ');
  }

  function updateKindFields() {
    const kind = $('kind').value;
    for (const el of document.querySelectorAll('.ep')) el.hidden = kind !== 'episode';
    for (const el of document.querySelectorAll('.mv')) el.hidden = kind !== 'movie';
    for (const el of document.querySelectorAll('.vd')) el.hidden = kind !== 'video';
    updateTarget();
    updatePreviewHeader();
  }

  function updateTarget() {
    const n = names();
    const outDir = getSettings().outDir || t('default_dir');
    const dir = n.sub ? `${n.folder}\\${n.sub}` : n.folder;
    $('target').textContent = t('target_line', { path: `${outDir}\\${dir}\\${n.base}.mp4` });
  }

  function selectedAudioLangsForEstimate() {
    const cur = current();
    const boxes = [...($('audios')?.querySelectorAll('input[type=checkbox]') || [])];
    if (!boxes.length) return 'all';
    const checked = boxes.filter(b => b.checked);
    if (cur?.probe?.type !== 'ytdlp' && checked.length === boxes.length) return 'all';
    return checked.map(b => b.dataset.lang || b.dataset.name).filter(Boolean);
  }

  function updateDownloadEstimate() {
    const cur = current();
    const estBox = $('downloadEst');
    if (!estBox) return;
    const estBytes = estimateBytes(cur?.probe, {
      height: Number($('quality').value) || null,
      audioLangs: selectedAudioLangsForEstimate(),
    });
    if (!(estBytes > 0)) {
      estBox.replaceChildren();
      return;
    }
    const sec = estimateSeconds(estBytes, avgSpeedBps);
    const min = Math.max(1, Math.round(sec / 60));
    estBox.replaceChildren(
      h('span', { class: 'est-size' }, bytes(estBytes)),
      h('br'),
      h('span', { class: 'est-time' }, t('est_min', { n: min })),
    );
  }

  function syncActionState() {
    const isDownloading = activeJob && ['queued', 'downloading', 'muxing'].includes(activeJob.state);
    const isDoneJob = activeJob && activeJob.state === 'done';
    const showExists = (Boolean(existing) || isDoneJob) && !forceRedownload && !isDownloading;

    const badge = $('doneBadge');
    if (badge) badge.hidden = !showExists;

    $('pageProgressWrap').hidden = !isDownloading;
    $('existsBox').hidden = !showExists;
    $('download').hidden = Boolean(isDownloading || showExists);

    if (isDownloading) {
      const p = activeJob.progress || {};
      const pct = Math.round(p.percent || 0);
      $('pageProgressFill').style.width = `${pct}%`;
      const leftParts = [t('percent', { n: pct })];
      if (p.speed) leftParts.push(t('speed', { n: (p.speed / 1e6).toFixed(1) }));
      else if (activeJob.state === 'muxing') leftParts.push(t('state_muxing'));
      $('pageProgressLeft').textContent = leftParts.join(' · ');
      let right = '';
      if (p.eta != null) {
        right = p.eta > 90 ? t('eta_min', { n: Math.round(p.eta / 60) }) : t('eta_sec', { n: p.eta });
      }
      $('pageProgressRight').textContent = right;
    } else if (showExists) {
      const size = existing?.size || activeJob?.output?.size || 0;
      const mtime = existing?.mtime || activeJob?.finishedAt || Date.now();
      let date = '';
      try { date = new Date(mtime).toLocaleDateString(langTag()); } catch { /* ignore */ }
      $('existsLine').textContent = t('already_downloaded', { size: bytes(size), date });
    }
  }

  async function checkExisting() {
    const seq = ++existsSeq;
    let found = null;
    if ($('pageForm').hidden) return;
    try {
      const n = names();
      const r = await api('GET', `/exists?folder=${encodeURIComponent(n.folder)}&base=${encodeURIComponent(n.base)}`);
      if (r.exists) found = r;
    } catch { /* convenience check */ }
    if (seq !== existsSeq) return;
    existing = found;
    syncActionState();
  }

  function scheduleExistsCheck() {
    forceRedownload = false;
    clearTimeout(existsTimer);
    existsTimer = setTimeout(checkExisting, 300);
  }

  function renderSourceDetails() {
    const cur = current();
    const ui = getUi();
    pick = chooseDefaults(cur?.probe, {
      uiLang: currentLang(),
      defaults: ui.defaults,
      memory: ui.siteMemory,
      host: pageHost(),
      subs: state?.subs,
    });
    chips.renderAll();
    updatePreviewHeader();
    updateDownloadEstimate();
  }

  async function showPreview({ youtubeUrl, source }) {
    const box = $('preview');
    const img = $('previewImg');
    const video = $('previewVideo');
    const ui = getUi();
    const frame = staticFrameUrl({ youtubeUrl, ogImage: state?.page?.ogImage, pageUrl: state?.page?.url });
    const clipUrl = source && source.kind !== 'file' ? source.url : null;
    const wantClip = Boolean(clipUrl) && wantsClip(ui.motion);
    box.hidden = false;
    if (frame) {
      img.src = frame;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
    video.classList.remove('on');
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = null;
    }
    if (!wantClip) return;
    const blob = await loadPreview(clipUrl, {
      kind: source.kind,
      playlists: source.playlists,
      headers: source.headers,
      pageUrl: state?.page?.url,
    });
    if (!blob) return;
    currentBlobUrl = blob;
    video.src = blob;
    video.addEventListener('loadeddata', () => {
      video.classList.add('on');
      video.play().catch(() => {});
    }, { once: true });
  }

  function chosenYoutubeOptions() {
    const langs = [...$('audios').querySelectorAll('input[data-lang]:checked')].map(b => b.dataset.lang);
    const subs = allSubs();
    const chosenSubs = [...$('subs').querySelectorAll('input[type=checkbox]:checked')].map(b => subs[Number(b.dataset.i)]);
    return {
      quality: Number($('quality').value) ? { height: Number($('quality').value) } : null,
      audio: langs.length ? langs : null,
      subtitles: chosenSubs.filter(Boolean).map(s => ({ lang: s.lang, auto: Boolean(s.auto) })),
    };
  }

  async function hasEpisodeList() {
    try {
      const { episodes } = await bg({ type: 'episodes' });
      return Boolean(episodes?.length);
    } catch { return false; }
  }

  async function updateSeasonHint() {
    const row = $('seasonHintRow');
    row.hidden = true;
    row.replaceChildren();
    if ($('kind').value !== 'episode') return;
    try {
      const { episodes } = await bg({ type: 'episodes' });
      if (!episodes?.length) return;
      const curSeason = Number($('season').value) || episodes[0].season;
      const curEp = Number($('episode').value) || 0;
      const inSeason = episodes
        .filter(e => e.season === curSeason && e.episode > curEp)
        .sort((a, b) => a.episode - b.episode);
      if (!inSeason.length) return;
      const nextEp = inSeason[0];
      const queueItems = async (btn, items) => {
        btn.disabled = true;
        try {
          await bg({
            type: 'queue-episodes',
            items: items.map(e => ({ url: e.url, season: e.season, episode: e.episode })),
            options: { name: $('name').value.trim(), height: Number($('quality').value) || null, subtitlesOnly: subsOnly, embedSubs: embedSubs() },
          });
          onJobAdded?.();
        } catch (e) {
          setStatus($('pageStatus'), errText(e), true);
        } finally {
          btn.disabled = false;
        }
      };
      const nextBtn = h('button', {
        type: 'button',
        class: 'hint-link',
        onclick: () => queueItems(nextBtn, [nextEp]),
      }, t('hint_next_ep', { n: nextEp.episode }));
      const restBtn = h('button', {
        type: 'button',
        class: 'hint-link accent',
        onclick: () => queueItems(restBtn, inSeason),
      }, t('hint_add_season_rest', { n: inSeason.length }));
      row.replaceChildren(nextBtn, h('span', { class: 'hint-sep', 'aria-hidden': 'true' }, ' · '), restBtn);
      row.hidden = false;
    } catch { /* ignore */ }
  }

  async function loadYoutube(status) {
    $('seasonBox').hidden = true;
    $('seasonHintRow').hidden = true;
    $('playlistBox').hidden = !yt.playlistUrl;
    $('kind').value = 'video';
    updateKindFields();
    if (!yt.videoUrl) {
      setViewState('unsupported');
      setStatus(status, t('status_playlist_page'));
      $('playlistBox').open = true;
      return;
    }
    setViewState('searching');
    setStatus(status, t('status_yt_probing'));
    const probe = await api('POST', '/probe', { kind: 'ytdlp', url: yt.videoUrl, cookies: await youtubeCookies() });
    if (probe.isLive) {
      setViewState('error', { code: 'live' });
      return;
    }
    analyzed = [{ source: { kind: 'ytdlp', url: yt.videoUrl }, probe, label: 'YouTube' }];
    $('source').replaceChildren(h('option', { value: 0 }, 'YouTube'));
    $('sourceRow').hidden = true;
    $('name').value = probe.title || '';
    $('channel').value = probe.channel || '';
    updateTarget();
    renderSourceDetails();
    setViewState('ready');
    setStatus(status, t('status_yt_ready', { duration: probe.duration ? dur(probe.duration) : '', n: probe.audios.length }));
    $('pageForm').hidden = false;
    checkExisting();
    showPreview({ youtubeUrl: yt.videoUrl, source: { kind: 'ytdlp', url: yt.videoUrl } });
  }

  // "Follow" row: on any page with an episode list (series page or episode page), outside the
  // download form, because a series page has no video.
  async function updateFollowRow() {
    const row = $('followRow');
    if (!row) return;
    try {
      const { episodes } = await bg({ type: 'episodes' });
      if (!episodes?.length) {
        row.hidden = true;
        return;
      }
      const { follow } = await bg({ type: 'follow-status' });
      if (follow) {
        const off = h('button', {
          type: 'button',
          class: 'hint-link',
          onclick: async () => {
            off.disabled = true;
            await bg({ type: 'follow-remove', id: follow.id }).catch(() => {});
            updateFollowRow();
            updateFollowCard();
          },
        }, t('follow_unfollow'));
        row.replaceChildren(h('span', { class: 'follow-on' }, `✓ ${t('follow_following')}`),
          h('span', { class: 'hint-sep', 'aria-hidden': 'true' }, ' · '), off);
      } else {
        const on = h('button', {
          type: 'button',
          class: 'hint-link accent',
          onclick: async () => {
            on.disabled = true;
            try {
              await bg({ type: 'follow-add', name: $('name')?.value.trim() || '' });
            } catch (e) {
              setStatus($('pageStatus'), errText(e), true);
            }
            updateFollowRow();
          },
        }, `＋ ${t('follow_btn')}`);
        row.replaceChildren(on);
      }
      row.hidden = false;
    } catch {
      row.hidden = true;
    }
  }

  // "New episodes" card: what the follow checks found and the user did not take yet.
  async function updateFollowCard() {
    const card = $('followCard');
    if (!card) return;
    const { follows } = await bg({ type: 'follow-list' }).catch(() => ({ follows: [] }));
    const withNew = (follows || []).filter(f => f.pending?.length);
    if (!withNew.length) {
      card.hidden = true;
      card.replaceChildren();
      return;
    }
    const p2 = n => String(n).padStart(2, '0');
    const act = (label, cls, fn) => {
      const btn = h('button', {
        type: 'button',
        class: `act ${cls}`,
        onclick: async () => {
          btn.disabled = true;
          try { await fn(); } catch (e) { setStatus($('pageStatus'), errText(e), true); }
          updateFollowCard();
        },
      }, label);
      return btn;
    };
    card.replaceChildren(
      h('div', { class: 'follow-card-title' }, t('follow_card_title')),
      ...withNew.map(f => h('div', { class: 'follow-group' },
        h('div', { class: 'follow-name' }, f.name),
        ...f.pending.map(p => {
          const ep = `${p.season}x${p.episode}`;
          return h('div', { class: 'follow-ep', 'data-ep': ep },
            h('span', { class: 'follow-ep-label' }, `S${p2(p.season)}E${p2(p.episode)}`),
            act(t('btn_download'), 'act-primary btn-follow-download', async () => {
              await bg({ type: 'follow-download', id: f.id, ids: [ep] });
              onJobAdded?.();
            }),
            act(t('follow_remove'), 'act-ghost btn-follow-remove', () => bg({ type: 'follow-dismiss', id: f.id, epId: ep })));
        }))));
    card.hidden = false;
  }

  // Drawn once per popup and again after an action: loadPage polls a page without a video every few
  // seconds, and a redraw on each poll would swap the buttons under the pointer.
  let followDrawn = false;

  async function loadPage() {
    if (!followDrawn) {
      followDrawn = true;
      updateFollowRow();
      updateFollowCard();
    }
    clearTimeout(searchTimer);
    clearTimeout(promptTimer);
    const status = $('pageStatus');
    setViewState('searching');
    setStatus(status, t('status_inspecting_page'));
    try {
      const s = await api('GET', '/settings');
      setSettings(s);
      if ($('outDir')) $('outDir').value = s.outDir || '';
    } catch (e) {
      if (['helper_missing', 'helper_no_reply', 'helper_unreachable'].includes(e?.code)) {
        setViewState('no-helper', e);
      } else {
        setViewState('error', e);
      }
      return;
    }
    try {
      state = await bg({ type: 'get-tab' });
      yt = youtubeTarget(state.page?.url || '');
      if (yt) return await loadYoutube(status);
      const host = (() => { try { return new URL(state.page?.url).hostname; } catch { return ''; } })();
      if (/(^|\.)youtube\.com$|youtu\.be$/.test(host)) {
        setViewState('unsupported');
        setStatus(status, t('status_open_yt'));
        return;
      }
      const m = state.meta || {};
      $('name').value = m.name || '';
      $('kind').value = m.kind || 'movie';
      $('season').value = m.season ?? '';
      $('episode').value = m.episode ?? '';
      $('year').value = m.year ?? '';
      updateKindFields();
      // A series page is not an episode but lists them (anime sites keep the list off the
      // episode pages): the season box belongs there too.
      $('seasonBox').hidden = m.kind !== 'episode' && !(await hasEpisodeList());

      if (!state.sources.length) {
        setViewState('searching');
        setStatus(status, t('status_no_video'));
        $('searchingPrompt').hidden = true;
        promptTimer = setTimeout(() => {
          const p = $('searchingPrompt');
          if (p) p.hidden = false;
        }, 3000);
        searchTimer = setTimeout(loadPage, 3000);
        return;
      }

      setStatus(status, t('status_inspecting_sources'));
      analyzed = await analyzeSources(state.sources, async s => {
        s.playlists = (await bg({ type: 'prefetch', source: s })).playlists;
        return api('POST', '/probe', { url: s.url, headers: s.headers, kind: s.kind, playlists: s.playlists });
      }, { fileLabel: t('source_file'), units: { h: t('unit_h'), m: t('unit_min') } });
      if (!analyzed.length) {
        const why = analyzed.errors?.length ? `(${[...new Set(analyzed.errors)].join('; ')})` : '';
        const err = Object.assign(new Error(t('status_sources_unreadable', { why }).trim()), {
          detail: analyzed.errors?.join('\n') || '',
        });
        setViewState('error', err);
        return;
      }
      const sel = $('source');
      sel.replaceChildren(...analyzed.map((a, i) => h('option', { value: i }, a.label)));
      $('sourceRow').hidden = analyzed.length < 2;
      renderSourceDetails();
      setViewState('ready');
      setStatus(
        status,
        analyzed[0].probe.duration
          ? t('status_video_found_dur', { duration: dur(analyzed[0].probe.duration) })
          : t('status_video_found'),
      );
      $('pageForm').hidden = false;
      checkExisting();
      showPreview({ source: analyzed[0].source });
      updateSeasonHint();
    } catch (e) {
      setViewState('error', e);
    }
  }

  async function rememberCurrentChoice() {
    try {
      const host = pageHost();
      if (!host) return;
      const audioBoxes = [...$('audios').querySelectorAll('input[type=checkbox]')];
      const checked = audioBoxes.filter(b => b.checked);
      const allHls = current()?.probe?.type !== 'ytdlp' && checked.length === audioBoxes.length;
      const audioLangs = !audioBoxes.length || allHls
        ? 'all'
        : [...new Set(checked.map(b => b.dataset.lang).filter(Boolean))];
      const subs = allSubs();
      const subtitleKeys = [...$('subs').querySelectorAll('input[type=checkbox]:checked')]
        .map(b => subtitleKey(subs[Number(b.dataset.i)]));
      await rememberChoice(host, { audioLangs, subtitleKeys, height: Number($('quality').value) || null });
    } catch { /* memory is a convenience */ }
  }

  async function startDownload() {
    const btn = $('download');
    const cur = current();
    if (!cur || btn.disabled) return;
    const kind = $('kind').value;
    if (cur.source.kind === 'ytdlp') {
      btn.disabled = true;
      try {
        // An older helper ignores subtitlesOnly and would download the whole video.
        if (subsOnly) await requireFeature('subs-only');
        await api('POST', '/jobs', {
          meta: { kind: 'video', name: $('name').value.trim() || 'Video', channel: $('channel').value.trim() || 'YouTube' },
          pageUrl: cur.source.url,
          source: { kind: 'ytdlp', url: cur.source.url },
          ...chosenYoutubeOptions(),
          subtitlesOnly: subsOnly,
          embedSubs: embedSubs(),
          cookies: await youtubeCookies(),
        });
        await rememberCurrentChoice();
        forceRedownload = false;
        onJobAdded?.();
      } catch (e) {
        setStatus($('pageStatus'), t('add_failed', { error: errText(e) }), true);
      } finally {
        btn.disabled = false;
      }
      return;
    }
    const audioBoxes = [...$('audios').querySelectorAll('input[type=checkbox]')];
    const chosenAudio = audioBoxes.filter(b => b.checked).map(b => b.dataset.name);
    const subs = allSubs();
    const chosenSubs = [...$('subs').querySelectorAll('input[type=checkbox]')]
      .filter(b => b.checked)
      .map(b => subs[Number(b.dataset.i)]);
    const job = {
      meta: {
        kind,
        name: $('name').value.trim() || 'Video',
        season: kind === 'episode' ? Number($('season').value) || 0 : null,
        episode: kind === 'episode' ? Number($('episode').value) || 0 : null,
        year: kind === 'movie' ? Number($('year').value) || null : null,
      },
      pageUrl: state?.page?.url || null,
      source: { kind: cur.source.kind, url: cur.source.url, headers: cur.source.headers },
      playlists: cur.source.playlists || null,
      quality: Number($('quality').value) ? { height: Number($('quality').value) } : null,
      audio: audioBoxes.length && chosenAudio.length < audioBoxes.length ? chosenAudio : 'all',
      subtitles: chosenSubs.filter(Boolean).map(s => ({
        url: s.url, label: s.label, lang: s.lang, headers: s.headers, hls: Boolean(s.hls),
      })),
      includeHlsSubtitles: false,
      subtitlesOnly: subsOnly,
      embedSubs: embedSubs(),
    };
    btn.disabled = true;
    try {
      if (subsOnly) await requireFeature('subs-only');
      await api('POST', '/jobs', job);
      await rememberCurrentChoice();
      forceRedownload = false;
      onJobAdded?.();
    } catch (e) {
      setStatus($('pageStatus'), t('add_failed', { error: errText(e) }), true);
    } finally {
      btn.disabled = false;
    }
  }

  // "Subtitles only" chip: quality and audio choices disappear, the button downloads subtitles.
  function applySubsOnly() {
    const chip = $('chip-subsonly');
    if (chip) {
      chip.classList.toggle('on', subsOnly);
      chip.setAttribute('aria-pressed', String(subsOnly));
      chip.replaceChildren(icon('cc'), h('span', { class: 'chip-text' }, t('lbl_subs_only')));
    }
    for (const id of ['chip-quality', 'chip-audio']) {
      const el = $(id);
      if (el) el.hidden = subsOnly;
    }
    if (subsOnly) chips.closeMenus();
    const lbl = $('downloadMainLabel')?.querySelector('[data-i18n]');
    if (lbl) lbl.textContent = t(subsOnly ? 'btn_download_subs' : 'download');
    const est = $('downloadEst');
    if (est) est.hidden = subsOnly;
  }

  function wire() {
    chips.wire();
    $('chip-subsonly')?.addEventListener('click', () => {
      subsOnly = !subsOnly;
      applySubsOnly();
    });
    applySubsOnly();

    // Decorate buttons with SVG icons
    $('downloadMainLabel')?.prepend(icon('download'));
    $('existsPlay')?.prepend(icon('play'));
    $('existsFolder')?.prepend(icon('folder'));
    $('doneBadge')?.prepend(icon('check'));

    $('editToggle')?.addEventListener('click', () => {
      const box = $('metaEditor');
      if (box) box.hidden = !box.hidden;
    });

    $('startPlayerBtn')?.addEventListener('click', async () => {
      await bg({ type: 'trigger' });
      setStatus($('pageStatus'), t('status_starting_player'));
    });

    $('reloadRetryBtn')?.addEventListener('click', async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const id = Number(new URLSearchParams(location.search).get('tab')) || tabs[0]?.id;
        if (id) await chrome.tabs.reload(id);
      } catch { /* ignore */ }
      setTimeout(loadPage, 1500);
    });

    $('noHelperBtn')?.addEventListener('click', () => {
      chrome.tabs.create({ url: RELEASES_URL }).catch(() => window.open(RELEASES_URL, '_blank'));
    });

    $('redownload')?.addEventListener('click', () => {
      forceRedownload = true;
      syncActionState();
    });
    $('existsPlay')?.addEventListener('click', () => {
      if (existing?.path) {
        api('POST', '/open-file', { path: existing.path }).catch(e => setStatus($('pageStatus'), errText(e), true));
      } else if (activeJob?.id) {
        api('POST', `/jobs/${activeJob.id}/open?play=1`).catch(e => setStatus($('pageStatus'), errText(e), true));
      }
    });
    $('existsFolder')?.addEventListener('click', () => {
      if (existing?.path) {
        api('POST', '/open-folder', { path: existing.path }).catch(e => setStatus($('pageStatus'), errText(e), true));
      } else if (activeJob?.id) {
        api('POST', `/jobs/${activeJob.id}/open`).catch(e => setStatus($('pageStatus'), errText(e), true));
      }
    });

    $('kind')?.addEventListener('change', () => {
      updateKindFields();
      scheduleExistsCheck();
      updateSeasonHint();
    });
    for (const id of ['name', 'season', 'episode', 'year', 'channel']) {
      $(id)?.addEventListener('input', () => {
        updateTarget();
        updatePreviewHeader();
        scheduleExistsCheck();
      });
    }
    $('source')?.addEventListener('change', renderSourceDetails);
    $('download')?.addEventListener('click', startDownload);

    $('findPlaylist')?.addEventListener('click', async () => {
      const box = $('playlistContent');
      box.replaceChildren(h('div', { class: 'muted small' }, t('playlist_loading')));
      let pl;
      try {
        pl = await api('POST', '/probe', { kind: 'ytdlp', url: yt.playlistUrl, playlist: true, cookies: await youtubeCookies() });
      } catch (e) {
        box.replaceChildren(h('div', { class: 'err small' }, t('playlist_failed', { error: errText(e) })));
        return;
      }
      const list = h('div', { class: 'episodes' }, pl.entries.map(e =>
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, 'data-i': e.index - 1 }), `${e.index}. ${e.title}`)));
      const add = h('button', {
        type: 'button',
        class: 'primary',
        onclick: async () => {
          const picked = [...list.querySelectorAll('input:checked')].map(b => pl.entries[Number(b.dataset.i)]);
          if (!picked.length) return;
          add.disabled = true;
          const opts = analyzed[0]?.probe?.type === 'ytdlp'
            ? chosenYoutubeOptions()
            : { quality: null, audio: null, subtitles: [{ lang: 'tr' }, { lang: 'en' }] };
          const cookies = await youtubeCookies();
          await api('POST', '/jobs', {
            jobs: picked.map(e => ({
              meta: { kind: 'video', name: e.title, folder: pl.title, index: e.index },
              pageUrl: e.url,
              source: { kind: 'ytdlp', url: e.url },
              ...opts,
              embedSubs: embedSubs(),
              cookies,
            })),
          });
          showView('queue');
          add.disabled = false;
        },
      }, t('btn_add_videos'));
      box.replaceChildren(
        h('div', { class: 'small' }, t('playlist_info', { title: pl.title, n: pl.entries.length, folder: sanitize(pl.title) })),
        list,
        add,
      );
    });

    $('findEpisodes')?.addEventListener('click', async () => {
      const box = $('seasonContent');
      box.replaceChildren(h('div', { class: 'muted small' }, t('episodes_searching')));
      const { episodes } = await bg({ type: 'episodes' });
      if (!episodes.length) {
        box.replaceChildren(h('div', { class: 'muted small' }, t('episodes_none')));
        return;
      }
      const seasons = [...new Set(episodes.map(e => e.season))];
      const curSeason = Number($('season').value) || seasons[0];
      const seasonSel = h('select', {}, seasons.map(s => h('option', { value: s, selected: s === curSeason }, t('season_n', { n: s }))));
      const list = h('div', { class: 'episodes' });
      const renderList = () => {
        const s = Number(seasonSel.value);
        list.replaceChildren(...episodes.filter(e => e.season === s).map(e =>
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, 'data-url': e.url, 'data-s': e.season, 'data-e': e.episode }),
            t('episode_n', { n: e.episode }))));
      };
      seasonSel.addEventListener('change', renderList);
      renderList();
      const addError = h('div', { class: 'err small', hidden: true });
      const add = h('button', {
        type: 'button',
        class: 'primary',
        onclick: async () => {
          const items = [...list.querySelectorAll('input:checked')].map(b => ({
            url: b.dataset.url, season: Number(b.dataset.s), episode: Number(b.dataset.e),
          }));
          if (!items.length) return;
          add.disabled = true;
          addError.hidden = true;
          try {
            await bg({ type: 'queue-episodes', items, options: { name: $('name').value.trim(), height: Number($('quality').value) || null, subtitlesOnly: subsOnly, embedSubs: embedSubs() } });
            showView('queue');
          } catch (e) {
            addError.textContent = errText(e);
            addError.hidden = false;
          } finally {
            add.disabled = false;
          }
        },
      }, t('btn_add_episodes'));
      box.replaceChildren(
        h('label', {}, t('lbl_season'), seasonSel),
        list,
        h('div', { class: 'muted small' }, t('season_hint')),
        addError,
        add,
      );
    });
  }

  function onJobsUpdate(jobs) {
    // Update average speed from most recent finished job with avgSpeed
    const doneWithSpeed = [...(jobs || [])].reverse().find(j => j.state === 'done' && j.stats?.avgSpeed > 0);
    if (doneWithSpeed && doneWithSpeed.stats.avgSpeed !== avgSpeedBps) {
      avgSpeedBps = doneWithSpeed.stats.avgSpeed;
      updateDownloadEstimate();
    }
    if ($('pageForm').hidden) return;
    const n = names();
    const matching = [...(jobs || [])].reverse().find(
      j => j.names?.folder === n.folder && j.names?.base === n.base && ['queued', 'downloading', 'muxing', 'done'].includes(j.state),
    );
    activeJob = matching || null;
    syncActionState();
  }

  return {
    wire,
    loadPage,
    onJobsUpdate,
    closeMenus: () => chips.closeMenus(),
    refreshI18n() {
      if (!$('pageForm').hidden) {
        const cur = current();
        const status = $('pageStatus');
        if (cur?.source?.kind === 'ytdlp') {
          setStatus(status, t('status_yt_ready', { duration: cur.probe.duration ? dur(cur.probe.duration) : '', n: cur.probe.audios.length }));
        } else if (cur) {
          setStatus(status, cur.probe.duration ? t('status_video_found_dur', { duration: dur(cur.probe.duration) }) : t('status_video_found'));
        }
        chips.renderAll();
        applySubsOnly();
        updateTarget();
        updatePreviewHeader();
        updateDownloadEstimate();
        syncActionState();
        updateSeasonHint();
      }
    },
  };
}
