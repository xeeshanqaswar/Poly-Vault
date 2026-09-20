'use strict';

// Copies the bundled Montserrat woff2 files (from @fontsource/montserrat, a
// devDependency) into ui/assets/fonts so the app can ship them offline.
// Works both for dev (./ui) and packed (asar) runs.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'node_modules', '@fontsource', 'montserrat', 'files');
const DEST = path.join(__dirname, '..', 'ui', 'assets', 'fonts');
const WEIGHTS = [300, 400, 500, 600, 700];

if (!fs.existsSync(SRC)) {
  console.error('@fontsource/montserrat not installed — run: npm i -D @fontsource/montserrat');
  process.exit(1);
}

fs.mkdirSync(DEST, { recursive: true });
for (const w of WEIGHTS) {
  const src = path.join(SRC, `montserrat-latin-${w}-normal.woff2`);
  fs.copyFileSync(src, path.join(DEST, `montserrat-latin-${w}-normal.woff2`));
}
console.log(`fonts written to ${DEST} (Montserrat 300/400/500/600/700)`);