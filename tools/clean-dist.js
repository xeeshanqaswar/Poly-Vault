'use strict';

// Packaging must start from an empty output folder: otherwise old installers,
// blockmaps and a stale win-unpacked tree linger next to the new build.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

for (const name of process.argv.slice(2)) {
  const target = path.resolve(repoRoot, name);
  if (target === repoRoot || !target.startsWith(repoRoot + path.sep)) {
    console.error(`refusing to remove ${target} (outside the repository)`);
    process.exit(1);
  }
  fs.rmSync(target, { recursive: true, force: true });
}
