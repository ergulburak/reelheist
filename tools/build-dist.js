'use strict';
// Assembles dist/app/ with portable node.exe, helper (without tests), extension (without tests), and host.cmd.

const fs = require('fs');
const path = require('path');
const { fetchNode, NODE_EXE } = require('./fetch-node');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'dist', 'app');

function copyTree(src, dest, { exclude = new Set() } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (exclude.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(s, d, { exclude });
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function buildDist() {
  if (!fs.existsSync(NODE_EXE)) {
    fetchNode();
  }

  fs.rmSync(APP_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(APP_DIR, 'node'), { recursive: true });

  fs.copyFileSync(NODE_EXE, path.join(APP_DIR, 'node', 'node.exe'));

  copyTree(path.join(ROOT, 'helper'), path.join(APP_DIR, 'helper'), {
    exclude: new Set(['test', 'host.bat', 'node_modules']),
  });

  copyTree(path.join(ROOT, 'extension'), path.join(APP_DIR, 'extension'), {
    exclude: new Set(['test', '_metadata']),
  });

  const extIdSrc = path.join(ROOT, 'keys', 'extension-id.txt');
  if (fs.existsSync(extIdSrc)) {
    fs.mkdirSync(path.join(APP_DIR, 'keys'), { recursive: true });
    fs.copyFileSync(extIdSrc, path.join(APP_DIR, 'keys', 'extension-id.txt'));
  }

  const hostCmd = '@echo off\r\n"%~dp0node\\node.exe" "%~dp0helper\\host.js" %*\r\n';
  fs.writeFileSync(path.join(APP_DIR, 'host.cmd'), hostCmd, 'utf8');

  console.log(`Built dist/app at ${APP_DIR}`);
  return APP_DIR;
}

if (require.main === module) {
  try {
    buildDist();
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

module.exports = { buildDist, APP_DIR };
