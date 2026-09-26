'use strict';

// Copies the bundled Inter woff2 files (from @fontsource/inter, a
// devDependency) into ui/assets/fonts so the app can ship them offline.
// Works both for dev (./ui) and packed (asar) runs.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'node_modules', '@fontsource', 'inter', 'files');
const DEST = path.join(__dirname, '..', 'ui', 'assets', 'fonts');
const WEIGHTS = [300, 400, 500, 600, 700];

if (!fs.existsSync(SRC)) {
  console.error('@fontsource/inter not installed — run: npm i -D @fontsource/inter');
  process.exit(1);
}

fs.mkdirSync(DEST, { recursive: true });
for (const w of WEIGHTS) {
  const src = path.join(SRC, `inter-latin-${w}-normal.woff2`);
  if (!fs.existsSync(src)) {
    console.error(`missing ${src}`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(DEST, `inter-latin-${w}-normal.woff2`));
}

// Drop the old Montserrat faces (replaced by Inter in the 0.4 UI refresh).
for (const w of [300, 400, 500, 600, 700]) {
  const old = path.join(DEST, `montserrat-latin-${w}-normal.woff2`);
  if (fs.existsSync(old)) fs.unlinkSync(old);
}

console.log(`fonts written to ${DEST} (Inter 300/400/500/600/700)`);