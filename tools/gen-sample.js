'use strict';

// Generates sample-library/ with a couple of demo assets so the app can be
// tried immediately. Creates tiny real PNG previews via zlib (no deps).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'sample-library', 'Demo Assets');

function makePng(width, height, [r, g, b]) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(1 + width * 3);
    line[0] = 0; // filter: none
    const shade = ((y * 31) % 90) + 90; // subtle vertical gradient
    const rr = r + ((shade - 128) >> 2);
    const gg = g + ((shade - 128) >> 2);
    const bb = b + ((shade - 128) >> 2);
    for (let x = 0; x < width; x++) {
      line[1 + x * 3] = rr;
      line[2 + x * 3] = gg;
      line[3 + x * 3] = bb;
    }
    rows.push(line);
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = zlib.crc32Sign ? Buffer.alloc(0) : Buffer.alloc(0);
    const body = Buffer.concat([typeBuf, data]);
    const full = Buffer.concat([
      len,
      body,
      Buffer.from([0, 0, 0, 0]),
    ]);
    return full;
  };

  // Build chunks manually with CRC
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const deflated = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflated),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

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

const assets = [
  {
    cat: '3d/Props/Furniture',
    name: 'Rustic Chair',
    color: [150, 90, 45],
    files: { 'chair.fbx': 'FBX binary placeholder', 'chair_mat.mtl': 'material' },
  },
  {
    cat: '3d/Props/Furniture',
    name: 'Oak Table',
    color: [140, 95, 50],
    files: { 'table.fbx': 'FBX binary placeholder', 'table_mat.mtl': 'material' },
  },
  {
    cat: '3d/Vehicles',
    name: 'Go-Kart',
    color: [190, 60, 50],
    files: { 'kart.obj': 'OBJ placeholder', 'wheels.png': 'texture placeholder' },
  },
  {
    cat: '3d/Props',
    name: 'Stone Vase',
    color: [110, 115, 125],
    files: { 'vase.obj': 'OBJ placeholder', 'vase.mtl': 'material' },
  },
  {
    cat: '2d/Textures/Nature',
    name: 'Groovy Grass',
    color: [70, 140, 60],
    files: { 'grass.png': 'texture placeholder' },
  },
  {
    cat: '2d/Textures/Wood',
    name: 'Wooden Crate',
    color: [120, 82, 40],
    files: { 'wood.tga': 'texture placeholder' },
  },
  {
    cat: 'Audio',
    name: 'Bottle Click',
    color: [40, 90, 160],
    files: { 'click.wav': 'audio placeholder' },
  },
];

fs.rmSync(path.dirname(OUT), { recursive: true, force: true });

for (const a of assets) {
  const dir = path.join(OUT, a.cat, a.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'preview.png'), makePng(256, 192, a.color));
  for (const [name, content] of Object.entries(a.files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

console.log(`sample library written to ${OUT}`);