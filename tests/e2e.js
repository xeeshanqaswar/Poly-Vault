'use strict';

// End-to-end check against the real Electron main process.
// Boots the app headless-ish with a fixture library, verifies the bridge,
// queues an import job, and shuts down.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'assetvault-e2e-'));
const USER_DATA = path.join(ROOT, 'userData');
const LIB = path.join(ROOT, 'MyAssets');

function write(rel, content) {
  const p = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

write('3d/Chair/preview.png', 'fake');
write('3d/Chair/chair.fbx', 'fake');
write('3d/Treasure/preview.jpg', 'fake');
write('3d/Treasure/treasure.obj', 'fake');
write('2d/GrassTex/preview.jpg', 'fake');
write('2d/GrassTex/grass.png', 'fake');
write('2d/Pack/sheet.unitypackage', 'fake');

const PORT = 7100;
const BASE = `http://127.0.0.1:${PORT}`;

const electronArgs = ['.', `--user-data-dir=${USER_DATA}`];
const env = {
  ...process.env,
  ASSETVAULT_USER_DATA: USER_DATA,
  ASSETVAULT_BOOT_LIBRARY: LIB,
};

const electronExe = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
assert.ok(fs.existsSync(electronExe), 'electron binary not found - run npm install');

const child = spawn(
  electronExe,
  electronArgs,
  { cwd: path.join(__dirname, '..'), env, stdio: 'inherit' }
);

let settled = false;
function fail(msg) {
  if (settled) return;
  settled = true;
  console.error('E2E FAIL:', msg);
  child.kill();
  process.exit(1);
}

function pass() {
  settled = true;
  console.log('E2E PASS');
  child.kill();
  process.exit(0);
}

async function waitForServer(ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/status`);
      if (res.ok) return;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('bridge did not come up in time');
}

async function waitForDiag(action, filter, what, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/__diag${action ? `?action=${encodeURIComponent(action)}` : ''}`);
    const j = await res.json();
    if (j.error) throw new Error(`diag error: ${j.error}`);
    if (filter(j)) return j;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${what}`);
}

(async () => {
  await waitForServer();

  const status = await (await fetch(`${BASE}/api/status`)).json();
  assert.strictEqual(status.ok, true);
  assert.strictEqual(status.libraryCount, 1);
  console.log(`bridge up, library registered: ${status.libraries[0].path}`);

  const lib = await (await fetch(`${BASE}/api/library`)).json();
  const scan = lib.libraries[0];
  const byName = (n) => scan.assets.find((a) => a.name === n);
  assert.ok(byName('Chair'), 'Chair present');
  assert.ok(byName('Treasure'), 'Treasure present');
  assert.ok(byName('GrassTex'), 'GrassTex present');
  assert.ok(byName('Pack'), 'Pack present');
  assert.strictEqual(byName('Chair').relPath, '3d/Chair');
  assert.strictEqual(byName('GrassTex').relPath, '2d/GrassTex');
  assert.strictEqual(scan.totalAssets, 4);
  console.log(`scan ok: ${scan.totalAssets} assets`);

  const chair = byName('Chair');
  assert.strictEqual(chair.importable, true);

  const preview = await fetch(`${BASE}/api/preview?path=${encodeURIComponent(chair.preview.path)}`);
  assert.strictEqual(preview.status, 200);

  const tagPut = await fetch(`${BASE}/api/tags`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: chair.folder, tags: ['demo', 'test'] }),
  });
  assert.strictEqual(tagPut.status, 200);

  const metaPut = await fetch(`${BASE}/api/meta`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: chair.folder, description: 'A comfortable demo chair' }),
  });
  const metaPutJson = await metaPut.json();
  assert.strictEqual(metaPut.status, 200);
  assert.strictEqual(metaPutJson.description, 'A comfortable demo chair');
  const metaGet = await (await fetch(`${BASE}/api/meta`)).json();
  assert.ok(metaGet.ok);
  assert.strictEqual(metaGet.meta[chair.folder].description, 'A comfortable demo chair');

  const create = await fetch(`${BASE}/api/import-job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      assetId: chair.id,
      assetName: chair.name,
      category: chair.category,
      libraryName: 'MyAssets',
      assetFolder: chair.folder,
      tags: ['demo', 'test'],
      importables: chair.importables,
    }),
  });
  assert.strictEqual(create.status, 201);
  const { job } = await create.json();
  console.log(`job queued: ${job.id} (${job.assetName})`);

  const active = await (await fetch(`${BASE}/api/unity/import-jobs`)).json();
  assert.strictEqual(active.jobs.length, 1);
  assert.strictEqual(active.jobs[0].id, job.id);

  const finish = await fetch(`${BASE}/api/unity/import-jobs/${job.id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'e2e complete' }),
  });
  assert.strictEqual(finish.status, 200);

  const after = await (await fetch(`${BASE}/api/unity/import-jobs`)).json();
  assert.strictEqual(after.jobs.length, 0);

  // The renderer window should have built the tree sidebar + asset grid.
  const diag = await waitForDiag(
    null,
    (j) => j.libs >= 1 && j.treeRows >= 1 && j.cards === 4 && j.dot.includes('online'),
    'renderer UI to render libraries + 4 asset cards'
  );
  console.log(`renderer ok: libs=${diag.libs}, treeRows=${diag.treeRows}, cards=${diag.cards}, derivedState=${diag.dot}`);

  // Click the 3d container -> folder detail should show aggregated info + tags.
  // Force a rescan first so the renderer picks up the tags added above.
  await waitForDiag('rescan', (j) => j.libs >= 1, 'renderer to re-scan libraries');
  const containerDiag = await waitForDiag(
    'selectRel:3d',
    (j) => j.detail === '3d' && j.view === 'container' && j.metaRows >= 5 && j.contTagChips === 2,
    'container detail (3d) to render aggregated stats + descendant tags'
  );
  console.log(`container detail ok: metaRows=${containerDiag.metaRows}, descendant tag chips=${containerDiag.contTagChips}`);

  // Click the first card -> asset detail renders again.
  const assetDiag = await waitForDiag(
    'selectFirstCard',
    (j) => j.detail === 'Chair' && j.view === 'asset' && j.metaRows >= 5 && j.descEditors >= 1,
    'asset detail to render after selecting a card'
  );
  console.log(`asset detail ok: detail=${assetDiag.detail}, view=${assetDiag.view}, metaRows=${assetDiag.metaRows}`);

  // Theme switching + resizable splitters present.
  const themeLight = await waitForDiag(
    'theme:light',
    (j) => j.theme === 'light',
    'theme switch to light to apply'
  );
  const themeDark = await waitForDiag(
    'theme:dark',
    (j) => j.theme === 'dark',
    'theme switch to dark to apply'
  );
  assert.ok(themeDark.splitters === 2, `two resizable splitters present, got ${themeDark.splitters}`);
  assert.ok(themeDark.sbW >= 200, `sidebar width readable, got ${themeDark.sbW}`);
  console.log(`ui ok: theme=${themeDark.theme}, splitters=${themeDark.splitters}, sidebar=${themeDark.sbW}px`);
  pass();
})().catch((err) => {
  fail(err && err.message ? err.message : String(err));
});

child.on('exit', (code) => {
  if (!settled) fail(`app exited early with code ${code}`);
});