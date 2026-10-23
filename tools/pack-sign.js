#!/usr/bin/env node
// Site pack repository tool.
//   node tools/pack-sign.js keygen <dir>
//   node tools/pack-sign.js build <repoDir>
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const KEY_FILE = 'repo-private.pem';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function keygen(dir) {
  if (!dir) fail('Usage: pack-sign.js keygen <dir>');
  dir = path.resolve(dir);
  const keyPath = path.join(dir, KEY_FILE);
  if (fs.existsSync(keyPath)) fail(`Refusing to overwrite existing key: ${keyPath}`);
  fs.mkdirSync(dir, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

  const repoPath = path.join(dir, 'repo.json');
  let meta = { schema: 1, name: path.basename(dir) };
  if (fs.existsSync(repoPath)) meta = JSON.parse(fs.readFileSync(repoPath, 'utf8'));
  meta.publicKey = raw.toString('base64');
  fs.writeFileSync(repoPath, JSON.stringify(meta, null, 2) + '\n');

  const giPath = path.join(dir, '.gitignore');
  const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
  if (!gi.split(/\r?\n/).some((l) => l.trim() === KEY_FILE)) {
    fs.writeFileSync(giPath, gi + (gi && !gi.endsWith('\n') ? '\n' : '') + KEY_FILE + '\n');
  }
  console.log(`Wrote ${keyPath} and ${repoPath}`);
  console.warn(`WARNING: ${KEY_FILE} is your private signing key. Never commit it or share it.`);
}

async function build(repoDir) {
  if (!repoDir) fail('Usage: pack-sign.js build <repoDir>');
  repoDir = path.resolve(repoDir);
  const keyPath = path.join(repoDir, KEY_FILE);
  if (!fs.existsSync(keyPath)) fail(`Missing ${keyPath}. Run keygen first.`);
  const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
  const toUrl = (rel) => pathToFileURL(path.resolve(__dirname, '..', rel)).href;
  const { validatePack, MAX_PACK_BYTES } = await import(toUrl('extension/lib/packs/schema.js'));
  const { sha256Hex } = await import(toUrl('extension/lib/packs/verify.js'));

  const packsDir = path.join(repoDir, 'packs');
  const files = fs.existsSync(packsDir)
    ? fs.readdirSync(packsDir).filter((f) => f.endsWith('.json')).sort()
    : [];
  const errors = [];
  const entries = [];
  for (const f of files) {
    const bytes = fs.readFileSync(path.join(packsDir, f));
    if (bytes.length > MAX_PACK_BYTES) {
      errors.push(`${f}: file is ${bytes.length} bytes, limit is ${MAX_PACK_BYTES}`);
      continue;
    }
    let obj;
    try { obj = JSON.parse(bytes.toString('utf8')); } catch (e) { errors.push(`${f}: invalid JSON (${e.message})`); continue; }
    const res = validatePack(obj);
    if (!res.ok) { for (const e of res.errors) errors.push(`${f}: ${e}`); continue; }
    const p = res.pack || obj;
    const base = f.slice(0, -'.json'.length);
    if (p.id !== base) { errors.push(`${f}: id "${p.id}" must equal the file name "${base}"`); continue; }
    entries.push({ f, bytes, p });
  }
  if (errors.length) fail('Build failed:\n' + errors.join('\n'));

  const packs = [];
  for (const { f, bytes, p } of entries) {
    const sig = crypto.sign(null, bytes, key).toString('base64');
    fs.writeFileSync(path.join(packsDir, f + '.sig'), sig + '\n');
    packs.push({
      id: p.id, name: p.name, version: p.version, lang: p.lang, hosts: p.hosts,
      file: `packs/${p.id}.json`, sha256: await sha256Hex(new Uint8Array(bytes)),
    });
  }
  packs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  fs.writeFileSync(path.join(repoDir, 'index.json'), JSON.stringify({ schema: 1, packs }, null, 2) + '\n');
  console.log(`Built ${packs.length} pack(s) in ${repoDir}`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'keygen') keygen(arg);
  else if (cmd === 'build') await build(arg);
  else fail('Usage: pack-sign.js keygen <dir> | build <repoDir>');
}
main().catch((e) => fail(e.stack || String(e)));
