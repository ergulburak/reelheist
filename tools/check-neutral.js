#!/usr/bin/env node
// Neutrality checker: fails when tracked text files contain blocklisted terms
// or personal-path patterns. "Tracked" means: not matched by .gitignore.
// Usage: node tools/check-neutral.js [--blocklist <file>] [--allow <path,path,...>]
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PERSONAL = [/C:\\Users\\[^\\]+/i, /@marker\.gs/i];

function parseArgs(argv) {
  const o = { blocklist: null, allow: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--blocklist') o.blocklist = argv[++i];
    else if (argv[i] === '--allow') o.allow = (argv[++i] || '').split(',').map(s => s.trim().replace(/\\/g, '/')).filter(Boolean);
  }
  return o;
}

function readTerms(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

function loadIgnore() {
  const f = path.join(ROOT, '.gitignore');
  if (!fs.existsSync(f)) return [];
  return readTerms(f);
}

function globToRegex(g) {
  return new RegExp('^' + g.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
}

// Simple gitignore subset: "dir/", "*.ext" / glob with *, exact paths.
function isIgnored(rel, patterns) {
  const parts = rel.split('/');
  for (let p of patterns) {
    if (p.endsWith('/')) {
      const d = p.replace(/^\//, '').slice(0, -1);
      if (d.includes('/')) {
        if (rel === d || rel.startsWith(d + '/')) return true;
      } else if (parts.slice(0, -1).some(seg => globToRegex(d).test(seg))) return true;
    } else if (p.includes('/')) {
      if (globToRegex(p.replace(/^\//, '')).test(rel)) return true;
    } else if (parts.some(seg => globToRegex(p).test(seg))) return true;
  }
  return false;
}

function* walk(dir, patterns) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (e.name === '.git' || isIgnored(rel + (e.isDirectory() ? '/' : ''), patterns)) continue;
    if (e.isDirectory()) yield* walk(full, patterns);
    else if (e.isFile()) yield { full, rel };
  }
}

function isBinary(buf) {
  return buf.subarray(0, 8192).includes(0);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const def = path.join(__dirname, 'neutral-blocklist.txt');
  const ex = path.join(__dirname, 'neutral-blocklist.example.txt');
  const blFile = opts.blocklist || (fs.existsSync(def) ? def : ex);
  const terms = readTerms(blFile).map(t => t.toLowerCase());
  const patterns = loadIgnore();
  const hits = [];
  const skipExt = /\.(png|jpe?g|gif|ico|exe|pem|zip|dll|woff2?|ttf)$/i;
  for (const { full, rel } of walk(ROOT, patterns)) {
    if (opts.allow.includes(rel) || skipExt.test(rel)) continue;
    const buf = fs.readFileSync(full);
    if (isBinary(buf)) continue;
    buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
      const low = line.toLowerCase();
      for (const t of terms) if (low.includes(t)) hits.push(`${rel}:${i + 1}: ${t}`);
      for (const re of PERSONAL) { const m = re.exec(line); if (m) hits.push(`${rel}:${i + 1}: ${m[0]}`); }
    });
  }
  if (hits.length) {
    console.log(hits.join('\n'));
    console.log(`FAIL: ${hits.length} hit(s)`);
    process.exit(1);
  }
  console.log('OK: no neutrality hits');
}

main();
