import test from 'node:test';
import assert from 'node:assert';
import { youtubeTarget } from '../lib/youtube.js';

test('youtubeTarget recognises video, shorts, youtu.be and playlists', () => {
  assert.deepStrictEqual(youtubeTarget('https://www.youtube.com/watch?v=0e3GPea1Tyg&t=10s'),
    { videoUrl: 'https://www.youtube.com/watch?v=0e3GPea1Tyg', playlistUrl: null });
  assert.deepStrictEqual(youtubeTarget('https://youtu.be/0e3GPea1Tyg?si=x'),
    { videoUrl: 'https://www.youtube.com/watch?v=0e3GPea1Tyg', playlistUrl: null });
  assert.deepStrictEqual(youtubeTarget('https://www.youtube.com/shorts/abcDEF12345'),
    { videoUrl: 'https://www.youtube.com/watch?v=abcDEF12345', playlistUrl: null });
  assert.deepStrictEqual(youtubeTarget('https://www.youtube.com/watch?v=abc123xyz00&list=PL123'),
    { videoUrl: 'https://www.youtube.com/watch?v=abc123xyz00', playlistUrl: 'https://www.youtube.com/playlist?list=PL123' });
  assert.deepStrictEqual(youtubeTarget('https://www.youtube.com/playlist?list=PL123'),
    { videoUrl: null, playlistUrl: 'https://www.youtube.com/playlist?list=PL123' });
  // Auto mixes are endless: no playlist download.
  assert.strictEqual(youtubeTarget('https://www.youtube.com/watch?v=abc123xyz00&list=RDabc').playlistUrl, null);
  assert.strictEqual(youtubeTarget('https://www.youtube.com/@MrBeast'), null);
  assert.strictEqual(youtubeTarget('https://video.example/dizi/x'), null);
});
