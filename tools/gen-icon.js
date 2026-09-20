'use strict';

// Generates:
//   - build/icon.ico (PNG-in-ICO, 256x256), build/icon.png (512x512),
//     build/icon.icns (macOS) — app icon for electron-builder
//   - ui/assets/icon.png (256x256, favicon) and ui/assets/logo.png (512x512)
// When branding/icon.png and branding/logo.png exist they are used as the
// sources; otherwise a fallback diamond is drawn. Pure Node + zlib, no deps.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pngDec = require('./png');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build');
const ASSET_DIR = path.join(ROOT, 'ui', 'assets');

const BRAND_ICON = path.join(ROOT, 'branding', 'icon.png');
const BRAND_LOGO = path.join(ROOT, 'branding', 'logo.png');
const BRAND_LOGO_H = path.join(ROOT, 'branding', 'logo-horizontal.png');

const loaded = { icon: null, logo: null, logoH: null };
if (fs.existsSync(BRAND_ICON)) loaded.icon = pngDec.decode(BRAND_ICON);
if (fs.existsSync(BRAND_LOGO)) loaded.logo = pngDec.decode(BRAND_LOGO);
if (fs.existsSync(BRAND_LOGO_H)) loaded.logoH = pngDec.decode(BRAND_LOGO_H);
const src = loaded.icon;
if (!src) console.log('branding/icon.png not found — using fallback diamond art');

// --- PNG writer (RGBA) ------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, pixelAt) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  const data = raw;
  let off = 0;
  for (let y = 0; y < height; y++) {
    data[off++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      data[off++] = r;
      data[off++] = g;
      data[off++] = b;
      data[off++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Icon artwork -----------------------------------------------------------

const TOP = [79, 140, 255];   // accent blue
const BOTTOM = [123, 107, 255]; // violet

function lerp(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}

function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const t = Math.max(0, Math.min(1,
    (apx * abx + apy * aby) / (abx * abx + aby * aby)));
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t);
  return Math.hypot(dx, dy);
}

function makePixelAt(size) {
  if (src) {
    const s = pngDec.resample(src.pixels, src.width, src.height, size, size);
    return (x, y) => {
      const i = (y * size + x) * 4;
      return [s[i], s[i + 1], s[i + 2], s[i + 3]];
    };
  }
  const s = size;
  const radius = s * 0.22;
  const cx = s * 0.5;
  const cy = s * 0.5;
  const d = s * 0.30;          // diamond half-diagonal
  const t = s * 0.028;         // stroke thickness
  const top = [cx, cy - d];
  const left = [cx - d, cy];
  const right = [cx + d, cy];
  const bottom = [cx, cy + d];
  const mid = [cx, cy];

  const outline = [top, left, right, bottom];
  const segments = [
    [top, left], [top, right], [left, bottom], [right, bottom],
    [left, mid], [right, mid], [mid, bottom],
  ];

  // rounded-rect membership helper
  const insideRounded = (x, y) => {
    const nx = Math.max(cx - d + radius, Math.min(x, cx + d - radius));
    const ny = Math.max(cy - (d + radius * 0.6), Math.min(y, cy + (d + radius * 0.6)));
    const dist = Math.hypot(x - nx, y - ny);
    return dist <= radius;
  };

  return (x, y) => {
    // background rounded square
    if (!insideRounded(x, y)) return [0, 0, 0, 0];
    const grad = lerp(TOP, BOTTOM, y / s);

    // diamond fill (slightly lighter, translucent)
    const dx = Math.abs(x - cx) / d + Math.abs(y - cy) / d;
    let [r, g, b] = grad;
    let a = 255;
    if (dx <= 1) {
      const light = 0.10;
      r = Math.round(r + (255 - r) * light);
      g = Math.round(g + (255 - g) * light);
      b = Math.round(b + (255 - b) * light);
    }

    // strokes
    for (const [p1, p2] of segments) {
      if (distToSegment(x + 0.5, y + 0.5, p1[0], p1[1], p2[0], p2[1]) < t / 2) {
        return [255, 255, 255, 235];
      }
    }
    return [r, g, b, a];
  };
}

// --- ICO container (classic multi-size BMP DIB entries) --------------------

// 32-bit bottom-up DIB + 1bpp AND mask, as required by the ICO format.
function dibFor(pixelAt, size) {
  const xor = Buffer.alloc(size * size * 4);
  let di = 0;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      xor[di++] = b; xor[di++] = g; xor[di++] = r; xor[di++] = a;
    }
  }
  const andStride = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(andStride * size); // all zero = fully opaque mask
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);          // XOR height + AND mask height
  header.writeUInt16LE(1, 12);               // planes
  header.writeUInt16LE(32, 14);              // bpp
  header.writeUInt32LE(0, 16);               // compression: BI_RGB
  header.writeUInt32LE(xor.length + and.length, 20);
  return Buffer.concat([header, xor, and]);
}

function pngInIco(pixelAtFor) {
  const sizes = [16, 32, 48, 256];
  const images = sizes.map((s) => dibFor(pixelAtFor(s), s));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);                // reserved
  header.writeUInt16LE(1, 2);                // type: icon
  header.writeUInt16LE(images.length, 4);    // count
  let offset = 6 + 16 * images.length;
  const entries = images.map((img, i) => {
    const e = Buffer.alloc(16);
    e[0] = sizes[i] >= 256 ? 0 : sizes[i];   // width (0 == 256)
    e[1] = sizes[i] >= 256 ? 0 : sizes[i];   // height
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);                   // planes
    e.writeUInt16LE(32, 6);                  // bpp
    e.writeUInt32LE(img.length, 8);          // bytes
    e.writeUInt32LE(offset, 12);             // offset
    offset += img.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images]);
}

// --- ICNS container (PNG entries for macOS) --------------------------------

// ICNS chunk: type (4 bytes) + 32-bit big-endian length + payload.
function icnsChunk(type, data) {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(8 + data.length, 4);
  return Buffer.concat([head, data]);
}

function pngInIcns(entries) {
  const body = Buffer.concat(entries.map(([type, png]) => icnsChunk(type, png)));
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

// --- Write outputs ----------------------------------------------------------

function writePixelPng(file, width, height, pixelAt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(width, height, pixelAt));
}

// App icons for electron-builder.
writePixelPng(path.join(OUT_DIR, 'icon.png'), 512, 512, makePixelAt(512));
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), pngInIco(makePixelAt));
fs.writeFileSync(
  path.join(OUT_DIR, 'icon.icns'),
  pngInIcns([
    ['ic07', encodePng(128, 128, makePixelAt(128))],
    ['ic08', encodePng(256, 256, makePixelAt(256))],
    ['ic09', encodePng(512, 512, makePixelAt(512))],
    ['ic10', encodePng(1024, 1024, makePixelAt(1024))],
  ])
);

// In-app logo (brand) and favicon, for both dev (./ui) and packed (asar) runs.
// The horizontal wordmark is preferred for the toolbar; square art is the fallback.
function pixelAtFrom(pixels, sw, sh, w, h) {
  const s = pngDec.resample(pixels, sw, sh, w, h);
  return (x, y) => {
    const i = (y * w + x) * 4;
    return [s[i], s[i + 1], s[i + 2], s[i + 3]];
  };
}

const logoSourceH = loaded.logoH;
if (logoSourceH) {
  const h = 640;
  const w = Math.round((h * logoSourceH.width) / logoSourceH.height);
  writePixelPng(path.join(ASSET_DIR, 'logo.png'), w, h, pixelAtFrom(logoSourceH.pixels, logoSourceH.width, logoSourceH.height, w, h));
} else {
  const logoSource = loaded.logo || loaded.icon;
  if (logoSource) {
    const logo = pngDec.resample(logoSource.pixels, logoSource.width, logoSource.height, 512, 512);
    writePixelPng(path.join(ASSET_DIR, 'logo.png'), 512, 512, (x, y) => {
      const i = (y * 512 + x) * 4;
      return [logo[i], logo[i + 1], logo[i + 2], logo[i + 3]];
    });
  } else {
    writePixelPng(path.join(ASSET_DIR, 'logo.png'), 512, 512, makePixelAt(512));
  }
}
writePixelPng(path.join(ASSET_DIR, 'icon.png'), 256, 256, makePixelAt(256));

console.log(`icons written to ${OUT_DIR} (icon.png, icon.ico, icon.icns) + ${ASSET_DIR} (logo.png, icon.png)`);