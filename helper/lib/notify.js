'use strict';
// Windows toast notifications, shown by a short PowerShell script (same pattern as pick-folder.js).
// A toast never blocks or fails a job: send() always resolves.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const P = require('./paths');

const APP_ID = 'ReelHeist';
// The installed extension's icon; the script uses it only when the file exists.
const ICON_FILE = path.join(P.DATA_DIR, 'app', 'extension', 'icons', 'icon128.png');
const I18N_DIR = path.join(__dirname, '..', 'guide', 'i18n');
// Error texts come from the extension (err_<code>); it sits next to the helper in the repo and in the install.
const EXT_LOCALES = path.join(__dirname, '..', '..', 'extension', '_locales');

// Text comes through environment variables and is set through the DOM, so it is never part of the XML string.
// Windows shows a toast only for a registered AppUserModelID: the script registers ours under HKCU
// (no admin rights), and writes the values only when they are missing or different.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $key = 'HKCU:\\Software\\Classes\\AppUserModelId\\' + $env:REELHEIST_TOAST_APPID
  if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
  $cur = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
  if ($cur.DisplayName -ne 'ReelHeist') { Set-ItemProperty -LiteralPath $key -Name DisplayName -Value 'ReelHeist' }
  $icon = $env:REELHEIST_TOAST_ICON
  if ($icon -and (Test-Path -LiteralPath $icon) -and $cur.IconUri -ne $icon) { Set-ItemProperty -LiteralPath $key -Name IconUri -Value $icon }
} catch { }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$nodes = $xml.GetElementsByTagName('text')
$nodes.Item(0).AppendChild($xml.CreateTextNode($env:REELHEIST_TOAST_TITLE)) | Out-Null
$nodes.Item(1).AppendChild($xml.CreateTextNode($env:REELHEIST_TOAST_BODY)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:REELHEIST_TOAST_APPID).Show($toast)
`;

function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// The name carries a hash of the content, so a changed script never reuses an old file.
function scriptFile() {
  const hash = crypto.createHash('sha256').update(SCRIPT).digest('hex').slice(0, 12);
  const file = path.join(os.tmpdir(), `reelheist-toast-${hash}.ps1`);
  if (!fs.existsSync(file)) {
    // Write and rename: two toasts at once must never run a half-written script.
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, '\ufeff' + SCRIPT.replace(/\r?\n/g, '\r\n'), 'utf8');
    try { fs.renameSync(tmp, file); } catch (e) {
      fs.rmSync(tmp, { force: true });
      if (!fs.existsSync(file)) throw e;
    }
  }
  return file;
}

function toastArgs({ title = '', body = '' } = {}) {
  return {
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile()],
    env: {
      ...process.env,
      REELHEIST_TOAST_TITLE: String(title),
      REELHEIST_TOAST_BODY: String(body),
      REELHEIST_TOAST_APPID: APP_ID,
      REELHEIST_TOAST_ICON: ICON_FILE,
    },
  };
}

// Resolves when the script ends or fails to start. Errors go to log.
// Under `node --test` it does nothing, so tests never put a toast on the screen.
function send({ title, body }, log = () => {}) {
  if (process.platform !== 'win32' || process.env.NODE_TEST_CONTEXT) return Promise.resolve();
  return new Promise(resolve => {
    try {
      const { args, env } = toastArgs({ title, body });
      const child = spawn(powershellExe(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env });
      const err = [];
      child.stderr.on('data', c => err.push(c));
      child.on('error', e => { log(`Bildirim gönderilemedi: ${e.message}`); resolve(); });
      child.on('close', code => {
        if (code !== 0) log(`Bildirim hatası (${code}): ${Buffer.concat(err).toString('utf8').trim().slice(0, 300)}`);
        resolve();
      });
    } catch (e) {
      log(`Bildirim gönderilemedi: ${e.message}`);
      resolve();
    }
  });
}

const cache = new Map();

function readLang(lang) {
  if (!/^[A-Za-z_]{2,10}$/.test(lang || '')) return null;
  try { return JSON.parse(fs.readFileSync(path.join(I18N_DIR, `${lang}.json`), 'utf8')); } catch { return null; }
}

const KEYS = ['notify_done', 'notify_done_subs', 'notify_done_subs_only', 'notify_done_warn', 'notify_failed',
  'notify_season_done', 'notify_resume'];

// Notification texts for a language; missing language or key falls back to English.
function texts(lang) {
  const id = readLang(lang) ? lang : 'en';
  if (!cache.has(id)) {
    const en = readLang('en') || {};
    const cur = readLang(id) || en;
    const out = {};
    for (const k of KEYS) out[k] = cur[k] || en[k] || '';
    cache.set(id, out);
  }
  return cache.get(id);
}

const errCache = new Map();

function readErrors(lang) {
  if (!/^[A-Za-z_]{2,10}$/.test(lang || '')) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(EXT_LOCALES, lang, 'messages.json'), 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(m)) if (k.startsWith('err_') && typeof v?.message === 'string') out[k] = v.message;
    return out;
  } catch { return null; }
}

// Translated text of an error code (the extension's err_<code>); '' when there is none.
function errorText(lang, code) {
  if (!code) return '';
  for (const id of [lang, 'en']) {
    if (!errCache.has(id)) errCache.set(id, readErrors(id));
    const text = errCache.get(id)?.[`err_${code}`];
    if (text) return text;
  }
  return '';
}

// Placeholders take their values. An empty value also drops the " · " in front of it;
// an unknown placeholder stays as it is.
function fill(text, vars = {}) {
  return String(text).replace(/(\s*·\s*)?\{(\w+)\}/g, (m, sep, k) => {
    if (vars[k] === undefined || vars[k] === null) return m;
    const v = String(vars[k]);
    return v ? `${sep || ''}${v}` : '';
  });
}

// '' when the size is unknown.
function formatSize(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return '';
  return b < 1e9 ? `${Math.max(1, Math.round(b / 1e6))} MB` : `${(b / 1e9).toFixed(1)} GB`;
}

module.exports = { toastArgs, send, texts, fill, formatSize, errorText };
