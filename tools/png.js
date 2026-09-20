'use strict';

// Pure-Node PNG decoder (8-bit, non-interlaced, RGB/RGBA/GRAY/PALETTE) + RGBA
// resampler. Kept dependency-free so it works everywhere Node does.

const fs = require('fs');
const zlib = require('zlib');

function decode(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png: ' + file);
  let off = 8;
  let width, height, bitDepth, colorType, interlace;
  let palette = null;
  let trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (!width || interlace || bitDepth !== 8) {
    throw new Error('unsupported png ' + file + ' (needs 8-bit, non-interlaced)');
  }

  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  if (colorType !== 0 && colorType !== 2 && colorType !== 3 && colorType !== 4 && colorType !== 6) {
    throw new Error('unsupported color type ' + colorType + ' in ' + file);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(width * height * 4);
  let pos = 0;
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const f = raw[pos++];
    const row = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const si = x * bpp;
      const di = (y * width + x) * 4;
      let r, g, b, a;
      if (colorType === 6) { r = row[si]; g = row[si + 1]; b = row[si + 2]; a = row[si + 3]; }
      else if (colorType === 2) { r = row[si]; g = row[si + 1]; b = row[si + 2]; a = 255; }
      else if (colorType === 0) { r = g = b = row[si]; a = 255; }
      else if (colorType === 4) { r = g = b = row[si]; a = row[si + 1]; }
      else {
        const idx = row[si];
        r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
        a = colorType === 3 && trns && idx < trns.length ? trns[idx] : 255;
      }
      px[di] = r; px[di + 1] = g; px[di + 2] = b; px[di + 3] = a;
    }
    prev = row;
  }
  return { width, height, pixels: px };
}

// Bilinear RGBA resample with edge clamping.
function resample(src, sw, sh, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = ((y + 0.5) * sh) / h - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = ((x + 0.5) * sw) / w - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      for (let c = 0; c < 4; c++) {
        const i00 = ((y0 * sw) + x0) * 4 + c;
        const i01 = ((y0 * sw) + x1) * 4 + c;
        const i10 = ((y1 * sw) + x0) * 4 + c;
        const i11 = ((y1 * sw) + x1) * 4 + c;
        const top = src[i00] * (1 - fx) + src[i01] * fx;
        const bot = src[i10] * (1 - fx) + src[i11] * fx;
        out[((y * w) + x) * 4 + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }
  return out;
}

module.exports = { decode, resample };