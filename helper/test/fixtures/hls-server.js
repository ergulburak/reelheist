'use strict';
// Synthetic HLS server for tests (valid MPEG-TS segments, configurable per-segment delay, request counter).

const http = require('http');

function makeTsBuffer(packets = 4) {
  const buf = Buffer.alloc(packets * 188, 0xff);
  for (let i = 0; i < packets; i++) {
    buf[i * 188] = 0x47;
    buf[i * 188 + 1] = 0x40;
    buf[i * 188 + 2] = 0x00;
    buf[i * 188 + 3] = 0x10;
  }
  return buf;
}

async function startHlsServer({ segments = 6, delayMs = 300 } = {}) {
  const ts = makeTsBuffer(6);
  const counts = new Map();
  const hits = [];

  const media = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    ...Array.from({ length: segments }, (_, i) => `#EXTINF:4.0,\nseg${i}.ts`),
    '#EXT-X-ENDLIST',
  ].join('\n');

  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720',
    'video.m3u8',
  ].join('\n');

  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    hits.push(u);
    counts.set(u, (counts.get(u) || 0) + 1);
    if (u === '/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(master);
      return;
    }
    if (u === '/video.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(media);
      return;
    }
    if (/^\/seg\d+\.ts$/.test(u)) {
      const t = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': ts.length });
        res.end(ts);
      }, delayMs);
      req.on('close', () => clearTimeout(t));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('connection', s => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/master.m3u8`,
    mediaUrl: `http://127.0.0.1:${port}/video.m3u8`,
    counts,
    hits,
    close: () => new Promise(r => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}

module.exports = { startHlsServer, makeTsBuffer };
