'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { scanLibrary } = require('../src/main/library');
const { startBridge } = require('../src/main/bridgeServer');
const { createEnrichment, mergeMetaEntry } = require('../src/main/enrichment');
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
  // ---- enrichment engine (fake store lookup, no network) ----
  const metaDB = {};
  const tagDB = {};
  let lookups = 0;
  const eng = createEnrichment({
    getMeta: (p) => metaDB[p] || null,
    setMeta: (p, entry) => {
      metaDB[p] = mergeMetaEntry(metaDB[p], entry, '2026-01-01T00:00:00.000Z');
      return metaDB[p];
    },
    getTags: (p) => tagDB[p] || [],
    setTags: (entries) => {
      for (const e of entries) {
        if (!e.tags || !e.tags.length) delete tagDB[e.path];
        else tagDB[e.path] = e.tags;
      }
    },
    lookup: async (name) => {
      lookups += 1;
      if (name === 'Chair') {
        return { found: true, name: 'Wooden Chair', url: 'https://store/p/1', category: '3D > Furniture', description: 'A low poly wooden chair with a fabric seat.' };
      }
      if (name === 'Ghost') throw new Error('network down');
      return { found: false };
    },
  });
  const waitIdle = async () => {
    for (let i = 0; i < 300; i += 1) {
      if (eng.status().state === 'idle') return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  };

  const freshItems = [
    { path: 'E:\\Lib\\Chair', name: 'Chair' },
    { path: 'E:\\Lib\\Ghost', name: 'Ghost' },
    { path: 'E:\\Lib\\Mystery', name: 'Mystery' },
  ];
  assert.strictEqual(eng.request(freshItems), 3, 'enrichment queues every new asset');
  assert.strictEqual(await waitIdle(), true, 'enrichment drains back to idle');
  assert.strictEqual(lookups, 3, 'each new asset looked up exactly once');
  assert.strictEqual(metaDB['E:\\Lib\\Chair'].found, true, 'found flag persisted');
  assert.ok(metaDB['E:\\Lib\\Chair'].description.includes('low poly'), 'fetched description persisted');
  assert.deepStrictEqual(tagDB['E:\\Lib\\Chair'], ['furniture', 'low-poly'], 'tags derived from description + category');
  assert.strictEqual(metaDB['E:\\Lib\\Ghost'].found, false, 'failed lookup recorded as not-found');
  assert.strictEqual(tagDB['E:\\Lib\\Ghost'], undefined, 'no tags invented when the lookup fails');
  assert.strictEqual(eng.request(freshItems), 0, 'already-enriched assets are never re-fetched');

  lookups = 0;
  assert.strictEqual(eng.request(freshItems, { force: true }), 2, 'force retries only the not-found assets');
  assert.strictEqual(await waitIdle(), true);
  assert.strictEqual(lookups, 2, 'force skips assets that already have a store description');

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
      applyBulk: (entries) => {
        const all = tagMap();
        for (const e of entries) {
          const key = path.resolve(e.path);
          if (!e.tags || !e.tags.length) delete all[key];
          else all[key] = e.tags;
        }
        tagsStore.set('tags', all);
        return entries.length;
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
    update: {
      run: async () => {
        const t = tagMap();
        const m = metaMap();
        const libs = store.libraries.map((l) =>
          scanLibrary(l, {
            getTags: (p) => t[path.resolve(p)] || [],
            getMeta: (p) => (m[path.resolve(p)] || {}).description || '',
          })
        );
        return { libraries: libs, targets: [] };
      },
    },
    enrichment: {
      request: () => 0,
      status: () => ({ state: 'idle', pending: 0, active: 0, done: 0, message: '' }),
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
  const prevEtag = prev.headers.get('etag');
  assert.ok(prevEtag && prevEtag.startsWith('W/"'), 'preview carries a weak ETag');
  assert.match(prev.headers.get('cache-control') || '', /private/, 'preview is privately cacheable');
  await prev.arrayBuffer();

  const revalidate = await fetch(`${base}/api/preview?path=${encodeURIComponent(chairLive.preview.path)}`, {
    headers: { 'If-None-Match': prevEtag },
  });
  assert.strictEqual(revalidate.status, 304, 'unchanged preview revalidates to 304');
  assert.strictEqual((await revalidate.text()).length, 0, '304 carries no body');

  const byDate = await fetch(`${base}/api/preview?path=${encodeURIComponent(chairLive.preview.path)}`, {
    headers: { 'If-Modified-Since': prev.headers.get('last-modified') || '' },
  });
  assert.strictEqual(byDate.status, 304, 'If-Modified-Since also revalidates to 304');

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

  // Enrichment status endpoint
  const enrichStatus = await (await fetch(`${base}/api/enrichment`)).json();
  assert.strictEqual(enrichStatus.ok, true);
  assert.strictEqual(enrichStatus.status.state, 'idle');

  // Scoped update endpoint (scans + returns targets)
  const updateRes = await fetch(`${base}/api/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: { type: 'library', libId: 'lib1' } }),
  });
  const updateJson = await updateRes.json();
  assert.strictEqual(updateJson.ok, true);
  assert.strictEqual(updateJson.libraries.length, 1);
  assert.deepStrictEqual(Array.isArray(updateJson.targets), true);
  assert.strictEqual(updateJson.status.state, 'idle');

  // Bulk tag apply (folder cascade: folder + descendant assets in one call)
  const cascade = await fetch(`${base}/api/tags/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: [chairLive.folder, byName('Vase').folder], add: ['indoor'], remove: ['wood'] }),
  });
  const cascadeJson = await cascade.json();
  assert.strictEqual(cascadeJson.ok, true);
  assert.strictEqual(cascadeJson.count, 2);
  const cascadeTags = await (await fetch(`${base}/api/tags`)).json();
  const chairCascade = cascadeTags.tags[path.resolve(chairLive.folder)];
  const vaseCascade = cascadeTags.tags[path.resolve(byName('Vase').folder)];
  assert.deepStrictEqual(chairCascade, ['furniture', 'indoor'], 'bulk apply merges add + removes remove');
  assert.deepStrictEqual(vaseCascade, ['indoor'], 'bulk apply sets tag on every listed path');

  const applyOutside = await fetch(`${base}/api/tags/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: [path.join(ROOT, 'outside.png')], add: ['x'] }),
  });
  assert.strictEqual(applyOutside.status, 403, 'bulk tag apply outside library rejected');

  const applyBad = await fetch(`${base}/api/tags/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: [] }),
  });
  assert.strictEqual(applyBad.status, 400, 'bulk apply with no paths rejected');

  // Restore chair tags for the job assertion below
  await fetch(`${base}/api/tags`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: chairLive.folder, tags: ['wood', 'furniture'] }),
  });

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

  // ---- enrichment wired through the bridge (real engine, fake lookup) ----
  const wMeta = {};
  const wTags = {};
  let wireLookups = 0;
  const wireEng = createEnrichment({
    getMeta: (p) => wMeta[path.resolve(p)] || null,
    setMeta: (p, entry) => {
      const key = path.resolve(p);
      wMeta[key] = mergeMetaEntry(wMeta[key], entry, '2026-01-01T00:00:00.000Z');
      return wMeta[key];
    },
    getTags: (p) => wTags[path.resolve(p)] || [],
    setTags: (entries) => {
      for (const e of entries) {
        const key = path.resolve(e.path);
        if (!e.tags.length) delete wTags[key];
        else wTags[key] = e.tags;
      }
    },
    lookup: async (name) => {
      wireLookups += 1;
      if (name === 'Chair') {
        return { found: true, name: 'Wooden Chair', category: '3D > Furniture', description: 'A low poly wooden chair with a fabric seat.' };
      }
      if (name === 'Mystery') return { found: false };
      return { found: false };
    },
  });
  const port2 = 7412;
  const wireBridge = startBridge({
    host: '127.0.0.1',
    port: port2,
    getState: () => store,
    tags: {
      getAll: () => wTags,
      set: (p, list) => {
        const key = path.resolve(p);
        if (!list.length) delete wTags[key];
        else wTags[key] = list;
        return wTags[key] || [];
      },
      applyBulk: (entries) => {
        for (const e of entries) {
          const key = path.resolve(e.path);
          if (!e.tags.length) delete wTags[key];
          else wTags[key] = e.tags;
        }
        return entries.length;
      },
    },
    meta: {
      getAll: () => wMeta,
      set: (p, description) => {
        const key = path.resolve(p);
        if (!description) delete wMeta[key];
        else wMeta[key] = { description };
        return wMeta[key] ? wMeta[key].description : '';
      },
    },
    update: {
      run: async (scope) => {
        const libs = store.libraries.map((l) =>
          scanLibrary(l, {
            getTags: (p) => wTags[path.resolve(p)] || [],
            getMeta: (p) => (wMeta[path.resolve(p)] || {}).description || '',
          })
        );
        const targets = [];
        for (const l of libs) {
          if (scope.type === 'all' || (scope.type === 'library' && l.id === (scope.libId || null))) {
            targets.push(...(l.assets || []).map((a) => ({ path: a.folder, name: a.name })));
          }
        }
        return { libraries: libs, targets };
      },
    },
    enrichment: {
      request: (items, opts) => wireEng.request(items, opts),
      status: () => wireEng.status(),
    },
  });
  await wireBridge.listen();
  const base2 = `http://127.0.0.1:${port2}`;

  // A plain scan auto-enriches every new asset (description + derived tags)
  await (await fetch(`${base2}/api/library`)).json();
  let drained = false;
  for (let i = 0; i < 400; i += 1) {
    if (wireEng.status().state === 'idle') { drained = true; break; }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.strictEqual(drained, true, 'bridge auto-enrichment drains to idle');
  assert.strictEqual(wireLookups, 5, 'every new asset looked up exactly once');
  assert.ok((wMeta[path.resolve(chairLive.folder)].description || '').includes('low poly'), 'auto-fetched description stored');
  assert.deepStrictEqual(wTags[path.resolve(chairLive.folder)], ['furniture', 'low-poly'], 'auto-tags derived from description');
  assert.strictEqual(wMeta[path.resolve(byName('Pack').folder)].found, false, 'assets with no store match are marked not-found');

  const afterScan = await (await fetch(`${base2}/api/library`)).json();
  const chairAfterScan = afterScan.libraries[0].assets.find((a) => a.name === 'Chair');
  assert.deepStrictEqual(chairAfterScan.tags, ['furniture', 'low-poly'], 'auto-tags flow into subsequent scans');
  assert.ok(chairAfterScan.description.includes('low poly'), 'auto-description flows into subsequent scans');

  // Update re-checks only the not-found assets (force), not the enriched ones
  wireLookups = 0;
  const wireUpdate = await (await fetch(`${base2}/api/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: { type: 'library', libId: 'lib1' } }),
  })).json();
  assert.strictEqual(wireUpdate.ok, true);
  assert.strictEqual(wireUpdate.targets.length, 5, 'library scope targets every asset');
  drained = false;
  for (let i = 0; i < 400; i += 1) {
    if (wireEng.status().state === 'idle') { drained = true; break; }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.strictEqual(drained, true);
  assert.strictEqual(wireLookups, 4, 'update retries only the 4 assets without a store description');

  // A user-typed description survives a later failed store lookup
  const packFolder = path.resolve(byName('Pack').folder);
  wMeta[packFolder].description = 'Hand-written notes about this pack';
  await (await fetch(`${base2}/api/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: { type: 'all' } }),
  })).json();
  drained = false;
  for (let i = 0; i < 400; i += 1) {
    if (wireEng.status().state === 'idle') { drained = true; break; }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.strictEqual(drained, true);
  assert.strictEqual(wMeta[packFolder].description, 'Hand-written notes about this pack', 'missed lookups never wipe a manual description');

  console.log('enrichment ok: auto-fetch on scan, derived tags, force-retry on update, manual edits kept');
  wireBridge.server.close();
  console.log('SMOKE PASS');
  process.exit(0);
})().catch((err) => {
  console.error('SMOKE FAIL:', err);
  process.exit(1);
});