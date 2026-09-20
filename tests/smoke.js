'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { scanLibrary } = require('../src/main/library');
const { startBridge } = require('../src/main/bridgeServer');
const { JsonStore } = require('../src/main/store');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'assetvault-smoke-'));

function write(rel, content) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// Nested fixture:
//   MyAssets
//     3d
//       Props
//         Furniture
//           Chair   -> preview.png + chair.fbx   (deep asset, importable mesh)
//           Vase    -> preview.jpg + vase.obj    (asset)
//       Vehicles
//         Car       -> preview.webp only         (not importable)
//     2d
//       GrassTex    -> preview.jpg + grass.png   (texture, importable)
//       Pack        -> preview.gif + sheet.unitypackage (unitypackage)
//     .git/config   (ignored)
//     Unused/       -> empty container, skipped
write('MyAssets/3d/Props/Furniture/Chair/preview.png', 'fake-png');
write('MyAssets/3d/Props/Furniture/Chair/chair.fbx', 'fake-fbx');
write('MyAssets/3d/Props/Furniture/Chair/readme.txt', 'hi');
write('MyAssets/3d/Props/Furniture/Vase/preview.jpg', 'fake-jpg');
write('MyAssets/3d/Props/Furniture/Vase/vase.obj', 'fake-obj');
write('MyAssets/3d/Vehicles/Car/preview.webp', 'fake-webp');
write('MyAssets/2d/GrassTex/preview.jpg', 'fake-jpg');
write('MyAssets/2d/GrassTex/grass.png', 'fake-png-tex');
write('MyAssets/2d/Pack/preview.gif', 'fake-gif');
write('MyAssets/2d/Pack/sheet.unitypackage', 'fake-pkg');
write('MyAssets/.git/config', '[core]');

const LIB_ROOT = path.join(ROOT, 'MyAssets');
const tagsGetter = () => [];
const lib = scanLibrary({ id: 'lib1', name: 'MyAssets', path: LIB_ROOT }, { getTags: tagsGetter });

assert.strictEqual(lib.totalAssets, 5, 'total asset count');

// Tree: 2d + 3d top-level containers
const names = (nodes) => nodes.map((n) => n.name).sort();
assert.deepStrictEqual(names(lib.tree), ['2d', '3d']);

const c3d = lib.tree.find((n) => n.name === '3d');
assert.strictEqual(c3d.type, 'container');
assert.strictEqual(c3d.count, 3);
const props = c3d.children.find((n) => n.name === 'Props');
const vehicles = c3d.children.find((n) => n.name === 'Vehicles');
const furniture = props.children.find((n) => n.name === 'Furniture');
assert.deepStrictEqual(names(furniture.children), ['Chair', 'Vase']);
assert.deepStrictEqual(names(vehicles.children), ['Car']);

// Flattened assets
const byName = (n) => lib.assets.find((a) => a.name === n);

const chair = byName('Chair');
assert.strictEqual(chair.relPath, '3d/Props/Furniture/Chair');
assert.strictEqual(chair.category, '3d/Props/Furniture');
assert.ok(chair.importable, 'Chair importable');
assert.strictEqual(chair.kind, 'mesh');
assert.ok(chair.preview && chair.preview.rel === 'preview.png');

const car = byName('Car');
assert.strictEqual(car.importable, false, 'Car not importable');

const pack = byName('Pack');
assert.strictEqual(pack.kind, 'unitypackage');

// New scanner metadata
assert.ok(typeof chair.created === 'string' && chair.created.length > 0, 'asset created date present');
assert.ok(typeof chair.updated === 'string' && chair.updated.length > 0, 'asset updated date present');
assert.strictEqual(c3d.assetCount, 3, 'container asset count');
assert.strictEqual(c3d.fileCount, 6, 'container file count (Chair 3 + Vase 2 + Car 1)');
assert.strictEqual(c3d.sizeBytes > 0, true, 'container size aggregated');
assert.strictEqual(c3d.kindCounts.mesh, 2, 'container mesh kind count (Chair fbx + Vase obj)');
assert.deepStrictEqual(c3d.tags, [], 'container tag aggregation starts empty');
assert.ok(typeof c3d.created === 'string' && c3d.created.length > 0, 'container created date present');

console.log(`scan ok: ${lib.totalAssets} assets, nested depth ok`);

// ---- bridge ----
(async () => {
  const jobsStore = new JsonStore(path.join(ROOT, 'jobs.json'), { jobs: [] });
  const tagsStore = new JsonStore(path.join(ROOT, 'tags.json'), { tags: {} });
  const metaStore = new JsonStore(path.join(ROOT, 'meta.json'), { meta: {} });
  const tagMap = () => tagsStore.get('tags') || {};
  const metaMap = () => metaStore.get('meta') || {};

  const store = {
    name: 'Poly Vault',
    version: '0.3.0',
    libraries: [{ id: 'lib1', name: 'MyAssets', path: LIB_ROOT }],
    jobs: jobsStore.get('jobs'),
  };
  const port = 7411;
  const bridge = startBridge({
    host: '127.0.0.1',
    port,
    getState: () => store,
    tags: {
      getAll: tagMap,
      set: (p, list) => {
        const all = tagMap();
        const key = path.resolve(p);
        if (!list.length) delete all[key];
        else all[key] = list;
        tagsStore.set('tags', all);
        return all[key];
      },
    },
    meta: {
      getAll: metaMap,
      set: (p, description) => {
        const all = metaMap();
        const key = path.resolve(p);
        if (!description) delete all[key];
        else all[key] = { description };
        metaStore.set('meta', all);
        return all[key] ? all[key].description : '';
      },
    },
  });
  await bridge.listen();
  const base = `http://127.0.0.1:${port}`;

  const status = await (await fetch(`${base}/api/status`)).json();
  assert.strictEqual(status.ok, true);
  assert.strictEqual(status.libraryCount, 1);

  const libData = await (await fetch(`${base}/api/library`)).json();
  const scan = libData.libraries[0];
  assert.strictEqual(scan.assets.length, 5);
  assert.strictEqual(scan.assets.filter((a) => a.tags.length === 0).length, 5);

  const chairLive = scan.assets.find((a) => a.name === 'Chair');
  const prev = await fetch(`${base}/api/preview?path=${encodeURIComponent(chairLive.preview.path)}`);
  assert.strictEqual(prev.status, 200);

  const outside = await fetch(`${base}/api/preview?path=${encodeURIComponent(path.join(ROOT, 'outside.png'))}`);
  assert.strictEqual(outside.status, 403, 'paths outside library rejected');

  // Tags round-trip
  const put = await fetch(`${base}/api/tags`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: chairLive.folder, tags: ['Wood', 'Furniture', '  ', 'wood'] }),
  });
  const putJson = await put.json();
  assert.strictEqual(putJson.ok, true);
  assert.deepStrictEqual(putJson.tags, ['wood', 'furniture'], 'tags normalized + deduped by set');

  const tagPut = await fetch(`${base}/api/tags`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path.join(ROOT, 'outside.png'), tags: ['x'] }),
  });
  assert.strictEqual(tagPut.status, 403, 'tagging outside library rejected');

  const tagsAfter = await (await fetch(`${base}/api/tags`)).json();
  assert.ok(tagsAfter.tags[path.resolve(chairLive.folder)], 'tag stored by resolved path');

  // Meta (description) round-trip
  const metaPut = await fetch(`${base}/api/meta`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: chairLive.folder, description: 'A wooden chair with thin legs' }),
  });
  const metaPutJson = await metaPut.json();
  assert.strictEqual(metaPut.status, 200);
  assert.strictEqual(metaPutJson.description, 'A wooden chair with thin legs');

  const metaPutWrap = await fetch(`${base}/api/meta`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: c3d.path, description: 'All vehicles and props' }),
  });
  assert.strictEqual(metaPutWrap.status, 200);

  const metaOutside = await fetch(`${base}/api/meta`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path.join(ROOT, 'outside.png'), description: 'nope' }),
  });
  assert.strictEqual(metaOutside.status, 403, 'meta edit outside library rejected');

  const metaAfter = await (await fetch(`${base}/api/meta`)).json();
  assert.strictEqual(metaAfter.meta[path.resolve(chairLive.folder)].description, 'A wooden chair with thin legs');

  const rescanned = await (await fetch(`${base}/api/library`)).json();
  const chairTagged = rescanned.libraries[0].assets.find((a) => a.name === 'Chair');
  assert.deepStrictEqual(chairTagged.tags, ['wood', 'furniture'], 'tags flow into scan results');
  assert.strictEqual(chairTagged.description, 'A wooden chair with thin legs', 'description flows into asset scan');
  const rescanTree3d = rescanned.libraries[0].tree.find((n) => n.name === '3d');
  assert.deepStrictEqual(rescanTree3d.tags, ['furniture', 'wood'], 'container aggregates descendant tags');
  assert.strictEqual(rescanTree3d.description, 'All vehicles and props', 'description flows into container scan');

  // Job with tags
  const jobRes = await fetch(`${base}/api/import-job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      assetId: chair.id,
      assetName: chair.name,
      category: chair.category,
      libraryName: 'MyAssets',
      assetFolder: chair.folder,
      tags: chairTagged.tags,
      importables: chair.importables,
    }),
  });
  assert.strictEqual(jobRes.status, 201);
  const { job } = await jobRes.json();
  assert.strictEqual(job.status, 'pending');
  assert.deepStrictEqual(job.tags, ['wood', 'furniture']);

  const active = await (await fetch(`${base}/api/unity/import-jobs`)).json();
  assert.strictEqual(active.jobs.length, 1);
  assert.strictEqual(active.jobs[0].id, job.id);

  const done = await fetch(`${base}/api/unity/import-jobs/${job.id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'ok' }),
  });
  assert.strictEqual(done.status, 200);

  const activeAfter = await (await fetch(`${base}/api/unity/import-jobs`)).json();
  assert.strictEqual(activeAfter.jobs.length, 0, 'job terminal');

  console.log('bridge ok: preview, auth guard, tags + meta round-trip, job queue');
  bridge.server.close();
  console.log('SMOKE PASS');
  process.exit(0);
})().catch((err) => {
  console.error('SMOKE FAIL:', err);
  process.exit(1);
});