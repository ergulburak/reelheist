'use strict';
// Draws the extension icon (blue rounded square, white download arrow) as PNGs.
// Usage: node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shape tests in unit coordinates (0..1).
function inRoundRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inArrow(x, y) {
  const stem = x > 0.42 && x < 0.58 && y > 0.18 && y < 0.55;
  const head = y >= 0.45 && y <= 0.72 && Math.abs(x - 0.5) <= (0.72 - y) * 1.05;
  const bar = x > 0.24 && x < 0.76 && y > 0.78 && y < 0.86;
  return stem || head || bar;
}

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (inRoundRect(x, y, 0.22)) {
            bg++;
            if (inArrow(x, y)) fg++;
          }
        }
      }
      const n = ss * ss;
      const a = bg / n;
      const f = bg ? fg / bg : 0;
      const i = (py * size + px) * 4;
      buf[i] = Math.round(59 + (255 - 59) * f);
      buf[i + 1] = Math.round(130 + (255 - 130) * f);
      buf[i + 2] = Math.round(246 + (255 - 246) * f);
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, buf);
}

const out = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(out, `icon${s}.png`), draw(s));
console.log('icons written to', out);
