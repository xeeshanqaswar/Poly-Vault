// Dev-only: decode a PNG (8-bit, non-interlaced) and report size + dominant colors.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png: ' + file);
  let off = 8;
  let width, height, bitDepth, colorType, interlace;
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
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!width || interlace) throw new Error('unsupported png ' + file);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : -1;
  if (channels < 0 || bitDepth !== 8) throw new Error('unsupported colorType/bitDepth ' + file + ' ct=' + colorType);

  const stride = width * channels;
  const rows = [];
  let pos = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[pos++];
    const row = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      row[i] = v & 0xff;
    }
    rows.push(row);
    prev = row;
  }

  const buckets = new Map();
  let n = 0, rs = 0, gs = 0, bs = 0;
  const rgba = [];
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    for (let x = 0; x < width; x++) {
      const i = x * channels;
      const r = row[i], g = row[i + 1], b = row[i + 2], a = channels === 4 ? row[i + 3] : 255;
      rgba.push(r, g, b, a);
      if (a < 40) continue; // skip transparent
      n++; rs += r; gs += g; bs += b;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const e = buckets.get(key) || { n: 0, rs: 0, gs: 0, bs: 0 };
      e.n++; e.rs += r; e.gs += g; e.bs += b; buckets.set(key, e);
    }
  }
  const mean = { r: Math.round(rs / n), g: Math.round(gs / n), b: Math.round(bs / n) };
  const top = [...buckets.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 10);
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return { file, width, height, opaque: n, mean: hex(mean), bands: top.map(([k, e]) => ({ count: e.n, pct: Math.round((10000 * e.n) / n) / 100, hex: hex({ r: Math.round(e.rs / e.n), g: Math.round(e.gs / e.n), b: Math.round(e.bs / e.n) }) })) };
}

for (const f of process.argv.slice(2)) {
  console.log(JSON.stringify(decodePng(f), null, 2));
}