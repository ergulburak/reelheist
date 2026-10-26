'use strict';
// Error codes shared with the extension (it maps `err_<code>` to a translated text).
// `detail` is English technical text for logs and the "details" line only.

const CODES = ['link_expired', 'drm', 'no_quality', 'playlist_empty', 'not_hls', 'ffmpeg_missing',
  'ytdlp_missing', 'ytdlp_failed', 'live', 'bad_segment', 'no_video', 'bad_request', 'internal',
  'episode_timeout', 'episode_unreadable', 'episode_short', 'episode_interrupted', 'state', 'no_subtitles'];

class CodedError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.name = 'CodedError';
    this.code = code;
    this.detail = detail || code;
  }
}

// Any thrown value -> { code, detail } with a code from CODES.
function toCoded(e) {
  const detail = (e && (e.detail || e.message)) || String(e);
  if (e && CODES.includes(e.code)) return { code: e.code, detail };
  if (e && [401, 403, 404, 410].includes(e.status)) return { code: 'link_expired', detail };
  return { code: 'internal', detail };
}

module.exports = { CODES, CodedError, toCoded };
