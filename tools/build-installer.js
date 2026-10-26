'use strict';
// Builds dist/app and compiles installer/reelheist.iss with Inno Setup 6 (ISCC.exe).
// If ISCC.exe is not installed, downloads Inno Setup 6 via curl.exe and installs it silently for the current user.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildDist } = require('./build-dist');

const ROOT = path.resolve(__dirname, '..');
const ISS_FILE = path.join(ROOT, 'installer', 'reelheist.iss');
// The version comes from helper/package.json (check-release.js keeps it equal to the .iss file).
const VERSION = require(path.join(ROOT, 'helper', 'package.json')).version;
const OUTPUT_EXE = path.join(ROOT, 'installer', 'Output', `ReelHeist-Setup-${VERSION}.exe`);
const INNO_URL = 'https://github.com/jrsoftware/issrc/releases/download/is-6_4_1/innosetup-6.4.1.exe';

function findIscc() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Inno Setup 6', 'ISCC.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Inno Setup 6', 'ISCC.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function ensureIscc() {
  let iscc = findIscc();
  if (iscc) return iscc;

  const setupExe = path.join(os.tmpdir(), 'innosetup-6.4.1.exe');
  console.log(`Downloading Inno Setup 6 from ${INNO_URL} ...`);
  execFileSync('curl.exe', ['-sSL', '--ssl-no-revoke', '--fail', '-o', setupExe, INNO_URL], { stdio: 'inherit', windowsHide: true });
  console.log('Installing Inno Setup 6 (/VERYSILENT /CURRENTUSER) ...');
  execFileSync(setupExe, ['/VERYSILENT', '/CURRENTUSER', '/SUPPRESSMSGBOXES', '/NORESTART'], { stdio: 'inherit', windowsHide: true });

  iscc = findIscc();
  if (!iscc) throw new Error('ISCC.exe was not found after installing Inno Setup 6');
  return iscc;
}

function buildInstaller() {
  buildDist();
  const iscc = ensureIscc();
  console.log(`Compiling ${ISS_FILE} with ${iscc} ...`);
  execFileSync(iscc, [ISS_FILE], { stdio: 'inherit', windowsHide: true });
  if (!fs.existsSync(OUTPUT_EXE)) {
    throw new Error(`Expected installer output not found: ${OUTPUT_EXE}`);
  }
  console.log(`Built installer: ${OUTPUT_EXE} (${fs.statSync(OUTPUT_EXE).size} bytes)`);
  return OUTPUT_EXE;
}

if (require.main === module) {
  try {
    buildInstaller();
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

module.exports = { buildInstaller, OUTPUT_EXE };
