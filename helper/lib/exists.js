'use strict';
// "Already downloaded" lookup and path guards for the open-file / open-folder routes.

const fs = require('fs');
const path = require('path');
const { sanitize } = require('./names');
const { CodedError } = require('./errors');

function bad(detail) { return new CodedError('bad_request', detail); }

// One path segment: non-empty string, no separators, no drive letter, not "." or "..".
function checkSegment(name, label) {
  if (typeof name !== 'string' || !name.trim()) throw bad(`${label} is required`);
  if (/[\/:]/.test(name) || path.isAbsolute(name)) throw bad(`${label} must be a plain name`);
  if (name.split(/[\/]/).some(s => s === '..' || s === '.')) throw bad(`${label} must not contain ".."`);
  return name;
}

function isInside(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Absolute file path that lies inside outDir and ends with .mp4; else bad_request.
function resolveInside(outDir, file, { ext = '.mp4' } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw bad('path must be absolute');
  if (ext && path.extname(file).toLowerCase() !== ext) throw bad(`path must end with ${ext}`);
  if (!isInside(outDir, file)) throw bad('path is outside the download folder');
  // Follow symlinks and junctions: the real location must still be inside the real outDir.
  let real;
  try { real = fs.realpathSync.native(file); } catch { throw bad('path does not exist'); }
  let realRoot;
  try { realRoot = fs.realpathSync.native(outDir); } catch { throw bad('download folder does not exist'); }
  if (!isInside(realRoot, real)) throw bad('path is outside the download folder');
  return file;
}

function checkExists(outDir, folder, base) {
  checkSegment(folder, 'folder');
  checkSegment(base, 'base');
  const file = path.join(outDir, sanitize(folder), `${sanitize(base)}.mp4`);
  if (!isInside(outDir, file)) throw bad('path is outside the download folder');
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('not a file');
    // A link that leads out of outDir counts as "not there".
    if (!isInside(fs.realpathSync.native(outDir), fs.realpathSync.native(file))) throw new Error('outside');
    return { exists: true, path: file, size: st.size, mtime: st.mtimeMs };
  } catch {
    return { exists: false, path: null, size: 0, mtime: null };
  }
}

module.exports = { checkExists, resolveInside, isInside };
