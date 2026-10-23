'use strict';
// CLI: node helper/migrate.js — copies the legacy data folder into the ReelHeist data folder.

const path = require('path');
const os = require('os');
const P = require('./lib/paths');
const { migrateLegacy } = require('./lib/migrate');

const legacyDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DiziIndirici');

migrateLegacy({ legacyDir, dataDir: P.DATA_DIR })
  .then(r => console.log(JSON.stringify(r)))
  .catch(e => { console.error(e.message); process.exit(1); });
