// Generates the PWA PNG icons with zero dependencies (node:zlib PNG encoder + 4x supersampling).
// Usage: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [11, 12, 14];
const ACCENT = [255, 138, 31];
const WHITE = [243, 242, 238];

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
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shape: the Blind Rally mark — a route that bends twice and ends in a ring, on near-black.
// `scale` shrinks the artwork for maskable icons (safe zone).
function colorAt(x, y, scale) {
  const u = (x - 0.5) / scale + 0.5;
  const v = (y - 0.5) / scale + 0.5;
  const ringC = [0.66, 0.34];
  const d = Math.hypot(u - ringC[0], v - ringC[1]);
  if (d < 0.07) return ACCENT;
  if (d > 0.12 && d < 0.17) return ACCENT;
  // route polyline (thick), from bottom-left up to ring
  const pts = [[0.3, 0.84], [0.3, 0.62], [0.5, 0.62], [0.5, 0.5]];
  const w = 0.045;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const minx = Math.min(ax, bx) - w, maxx = Math.max(ax, bx) + w;
    const miny = Math.min(ay, by) - w, maxy = Math.max(ay, by) + w;
    if (u >= minx && u <= maxx && v >= miny && v <= maxy) return WHITE;
  }
  return BG;
}

function render(size, scale = 1) {
  const ss = 4;
  const out = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = colorAt((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, scale);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const i = (y * size + x) * 3;
      out[i] = r / (ss * ss); out[i + 1] = g / (ss * ss); out[i + 2] = b / (ss * ss);
    }
  }
  return png(size, size, out);
}

function renderOg(w, h) {
  // Simple wide card: mark on the left half, plain background elsewhere.
  const ss = 2;
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const px = (x + (sx + 0.5) / ss - (w - h) / 2) / h;
        const py = (y + (sy + 0.5) / ss) / h;
        const c = px < 0 || px > 1 ? BG : colorAt(px, py, 0.8);
        r += c[0]; g += c[1]; b += c[2];
      }
      const i = (y * w + x) * 3;
      out[i] = r / (ss * ss); out[i + 1] = g / (ss * ss); out[i + 2] = b / (ss * ss);
    }
  }
  return png(w, h, out);
}

const dir = new URL('../public/icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('icon-192.png', dir), render(192));
writeFileSync(new URL('icon-512.png', dir), render(512));
writeFileSync(new URL('maskable-512.png', dir), render(512, 0.72));
writeFileSync(new URL('apple-touch-icon.png', dir), render(180, 0.86));
writeFileSync(new URL('og.png', dir), renderOg(1200, 630));
console.log('icons written to public/icons/');
