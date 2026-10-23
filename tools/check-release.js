'use strict';
// Verifies release metadata before packaging:
// - helper/release.json has non-empty "repo"
// - extension/lib/links.js has non-empty SUPPORT_URL and REPO_URL
// - version matches across extension/manifest.json, helper/package.json, and installer/reelheist.iss

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`check-release: FAIL - ${msg}`);
  process.exit(1);
}

const releaseJsonPath = path.join(ROOT, 'helper', 'release.json');
if (!fs.existsSync(releaseJsonPath)) fail('helper/release.json is missing');
const releaseJson = JSON.parse(fs.readFileSync(releaseJsonPath, 'utf8'));
if (typeof releaseJson.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(releaseJson.repo.trim())) {
  fail(`helper/release.json "repo" is invalid: ${JSON.stringify(releaseJson.repo)}`);
}

const linksPath = path.join(ROOT, 'extension', 'lib', 'links.js');
if (!fs.existsSync(linksPath)) fail('extension/lib/links.js is missing');
const linksSrc = fs.readFileSync(linksPath, 'utf8');
const supportMatch = /SUPPORT_URL\s*=\s*['"]([^'"]+)['"]/.exec(linksSrc);
const repoMatch = /REPO_URL\s*=\s*['"]([^'"]+)['"]/.exec(linksSrc);
if (!supportMatch || !supportMatch[1].startsWith('https://')) {
  fail('SUPPORT_URL in extension/lib/links.js is missing or empty');
}
if (!repoMatch || !repoMatch[1].startsWith('https://')) {
  fail('REPO_URL in extension/lib/links.js is missing or empty');
}

const extVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8')).version;
const helperVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'helper', 'package.json'), 'utf8')).version;
const issSrc = fs.readFileSync(path.join(ROOT, 'installer', 'reelheist.iss'), 'utf8');
const issVerMatch = /#define\s+MyAppVersion\s+"([^"]+)"/.exec(issSrc);
const issVer = issVerMatch ? issVerMatch[1] : '';

if (!extVer || extVer !== helperVer || extVer !== issVer) {
  fail(`Version mismatch: manifest=${extVer}, helper=${helperVer}, installer=${issVer}`);
}

console.log(`check-release: OK (repo=${releaseJson.repo}, version=${extVer})`);
