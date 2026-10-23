'use strict';

const path = require('path');
const os = require('os');

const DATA_DIR = process.env.REELHEIST_DATA
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ReelHeist');

module.exports = {
  DATA_DIR,
  DAEMON_INFO: path.join(DATA_DIR, 'daemon.json'),
  JOBS_FILE: path.join(DATA_DIR, 'jobs.json'),
  SETTINGS_FILE: path.join(DATA_DIR, 'settings.json'),
  WORK_DIR: path.join(DATA_DIR, 'work'),
  LOG_FILE: path.join(DATA_DIR, 'daemon.log'),
  FFMPEG_EXE: path.join(DATA_DIR, 'ffmpeg', 'bin', 'ffmpeg.exe'),
  YTDLP_DIR: path.join(DATA_DIR, 'yt-dlp'),
  COOKIES_FILE: path.join(DATA_DIR, 'yt-cookies.txt'),
  DEFAULT_OUT_DIR: path.join(os.homedir(), 'Downloads'),
};
