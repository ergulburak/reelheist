'use strict';
// Fails when user-visible text is hard-coded in the extension UI files instead of coming from
// extension/_locales. Usage: node tools/check-i18n.js   (exit 0 = clean)
const fs = require('fs');
const path = require('path');

const ext = path.join(__dirname, '..', 'extension');
const uiDir = path.join(ext, 'ui');
const files = [
  'popup.html', 'popup.js', 'background.js',
  ...fs.readdirSync(path.join(ext, 'content')).filter(f => f.endsWith('.js')).map(f => `content/${f}`),
  ...(fs.existsSync(uiDir) ? fs.readdirSync(uiDir).filter(f => f.endsWith('.js')).map(f => `ui/${f}`) : []),
];

// Literals that are data, not UI text (default folder/file names, glyphs).
const ALLOWED_TEXT = new Set(['', '×', '▾', '›', ' · ', 'HD', 'Video', 'YouTube', 'ReelHeist', 'Reel', 'Heist']);
const TURKISH = /['"`][^'"`]*[ğüşıöçĞÜŞİÖÇ][^'"`]*['"`]/;
const TEXT_CONTENT = /\.(?:textContent|innerText)\s*=\s*(['"])([^'"]*)\1/;
// Two or more plain words inside one quoted literal ("Could not connect"): UI text, not an id or selector.
const ENGLISH = /(['"])([A-Za-z]{3,}(?: [A-Za-z]{2,})+)\1/;

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

const problems = [];

for (const rel of files) {
  const src = fs.readFileSync(path.join(ext, rel), 'utf8');
  if (rel.endsWith('.html')) {
    const html = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<title>[\s\S]*?<\/title>/g, '');
    html.split('\n').forEach((line, i) => {
      if (TURKISH.test(line)) problems.push(`${rel}:${i + 1}: Turkish text in markup: ${line.trim()}`);
    });
    // Text between tags needs a data-i18n attribute on its element.
    for (const m of html.matchAll(/<(\w+)([^>]*)>([^<]*[A-Za-z]{2,}[^<]*)</g)) {
      if (!/data-i18n/.test(m[2])) problems.push(`${rel}: text without data-i18n in <${m[1]}>: ${m[3].trim()}`);
    }
    for (const m of html.matchAll(/\s(?:title|aria-label|placeholder)="([^"]*[A-Za-z]{2,}[^"]*)"/g)) {
      problems.push(`${rel}: hard-coded attribute text: ${m[1]}`);
    }
    continue;
  }
  stripComments(src).split('\n').forEach((line, i) => {
    const where = `${rel}:${i + 1}`;
    if (/^\s*(import|export)\b.*\bfrom\b/.test(line)) return;
    if (TURKISH.test(line)) problems.push(`${where}: Turkish text: ${line.trim()}`);
    const tc = line.match(TEXT_CONTENT);
    if (tc && !ALLOWED_TEXT.has(tc[2])) problems.push(`${where}: textContent literal: ${line.trim()}`);
    const en = line.replace(/class:\s*(['"])[^'"]*\1/g, '').match(ENGLISH);
    if (en && !ALLOWED_TEXT.has(en[2]) && !/new Error\(|throw |console\.|log\(|\.test\(|querySelector|\.match\(|cssText|style\.|system-ui/.test(line)) {
      problems.push(`${where}: English UI text literal: ${line.trim()}`);
    }
  });
}

if (problems.length) {
  console.error(`check-i18n: ${problems.length} hard-coded text problem(s)`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`check-i18n: OK (${files.length} files)`);
