import test from 'node:test';
import assert from 'node:assert/strict';
import { wantsClip, staticFrameUrl } from '../lib/preview.js';

test('wantsClip: off never, on always, auto follows reduced motion', () => {
  const reduce = q => ({ matches: /reduce/.test(q) });
  const none = () => ({ matches: false });
  assert.equal(wantsClip('off', none), false);
  assert.equal(wantsClip('on', reduce), true);
  assert.equal(wantsClip('auto', none), true);
  assert.equal(wantsClip('auto', reduce), false);
  assert.equal(wantsClip(undefined, none), true);
});

test('staticFrameUrl: YouTube thumbnail, else og:image resolved against the page', () => {
  assert.equal(staticFrameUrl({ youtubeUrl: 'https://www.youtube.com/watch?v=0e3GPea1Tyg' }),
    'https://i.ytimg.com/vi/0e3GPea1Tyg/hqdefault.jpg');
  assert.equal(staticFrameUrl({ ogImage: 'https://cdn.example/a.jpg' }), 'https://cdn.example/a.jpg');
  assert.equal(staticFrameUrl({ ogImage: '/a.jpg', pageUrl: 'https://x.example/p/1' }), 'https://x.example/a.jpg');
  assert.equal(staticFrameUrl({ ogImage: 'javascript:alert(1)' }), null);
  assert.equal(staticFrameUrl({}), null);
});
