'use strict';
// Downloads Node.js v22.14.0 win-x64 zip, verifies SHA-256 against SHASUMS256.txt,
// and extracts node.exe to dist/node/node.exe.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const VERSION = 'v22.14.0';
const ARCH = 'win-x64';
const BASE_NAME = `node-${VERSION}-${ARCH}`;
const ZIP_NAME = `${BASE_NAME}.zip`;
const BASE_URL = `https://nodejs.org/dist/${VERSION}`;

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const CACHE_DIR = path.join(DIST_DIR, '.cache');
const NODE_DIR = path.join(DIST_DIR, 'node');
const NODE_EXE = path.join(NODE_DIR, 'node.exe');

function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  execFileSync('curl.exe', ['-sSL', '--ssl-no-revoke', '--fail', '-o', tmp, url], { stdio: 'inherit', windowsHide: true });
  fs.renameSync(tmp, dest);
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex').toLowerCase();
}

function expectedSha256(shasumsText, filename) {
  for (const line of shasumsText.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m && m[2] === filename) return m[1].toLowerCase();
  }
  throw new Error(`Could not find ${filename} in SHASUMS256.txt`);
}

function fetchNode() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(NODE_DIR, { recursive: true });

  const shasumsPath = path.join(CACHE_DIR, `SHASUMS256-${VERSION}.txt`);
  if (!fs.existsSync(shasumsPath)) {
    console.log(`Downloading ${BASE_URL}/SHASUMS256.txt ...`);
    download(`${BASE_URL}/SHASUMS256.txt`, shasumsPath);
  }
  const shasumsText = fs.readFileSync(shasumsPath, 'utf8');
  const expected = expectedSha256(shasumsText, ZIP_NAME);

  const zipPath = path.join(CACHE_DIR, ZIP_NAME);
  if (!fs.existsSync(zipPath) || sha256File(zipPath) !== expected) {
    console.log(`Downloading ${BASE_URL}/${ZIP_NAME} ...`);
    download(`${BASE_URL}/${ZIP_NAME}`, zipPath);
  }

  const actual = sha256File(zipPath);
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${ZIP_NAME}: expected ${expected}, got ${actual}`);
  }
  console.log(`SHA-256 verified: ${actual}`);

  const extractTmp = path.join(CACHE_DIR, 'extract');
  fs.rmSync(extractTmp, { recursive: true, force: true });
  fs.mkdirSync(extractTmp, { recursive: true });

  execFileSync('tar.exe', ['-xf', zipPath, '-C', extractTmp, `${BASE_NAME}/node.exe`], { stdio: 'inherit', windowsHide: true });
  const extractedExe = path.join(extractTmp, BASE_NAME, 'node.exe');
  if (!fs.existsSync(extractedExe)) {
    throw new Error(`Extracted node.exe not found at ${extractedExe}`);
  }

  fs.copyFileSync(extractedExe, NODE_EXE);
  fs.rmSync(extractTmp, { recursive: true, force: true });

  const ver = execFileSync(NODE_EXE, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  if (ver !== VERSION) {
    throw new Error(`Unexpected node.exe version: expected ${VERSION}, got ${ver}`);
  }
  console.log(`Ready: ${NODE_EXE} (${ver})`);
  return NODE_EXE;
}

if (require.main === module) {
  try {
    fetchNode();
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

module.exports = { fetchNode, NODE_EXE, VERSION };
