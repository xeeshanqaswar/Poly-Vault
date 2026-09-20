'use strict';

/* global assetVault */

const state = {
  serverUrl: null,
  libsMeta: [],          // [{id,name,path,addedAt,missing}]
  libraries: [],         // full scans from /api/library (tree + assets)
  tagData: {},           // { absPath: string[] }
  metaData: {},          // { absPath: description }
  jobsByAsset: new Map(),// assetId -> latest job
  activeLibId: null,
  activeNode: null,      // { libId, rel } folder filter (= null for whole library / all)
  expanded: new Set(),   // `${libId}::${rel}` container keys
  activeTags: new Set(),
  selectedAssetId: null,
  detail: null,          // { kind:'asset'|'container'|'library', assetId?, libId?, rel? } | null
  search: '',
  online: false,
  unityUp: false,
  theme: null,
};

const $ = (sel) => document.querySelector(sel);

function el(tag, className, text, title) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  if (title) node.title = title;
  return node;
}

// Inline SVG set (stroke/fill via currentColor so themes just work).
const ICONS = {
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h3l2 2.2h7a2.5 2.5 0 0 1 2.5 2.5V17a2.5 2.5 0 0 1-2.5 2.5h-12A2.5 2.5 0 0 1 3.5 17V7z" fill="currentColor"/></svg>',
  cube: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l7.6 4.3v9.8L12 21.2l-7.6-4.3V7.1L12 2.8zM4.6 7.6l7.4 4.2 7.4-4.2M12 11.8v9.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function iconSpan(name, cls) {
  const s = document.createElement('span');
  s.className = `icon ${cls || ''}`;
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';
  return s;
}

let lastDataSig = null;

function fmtBytes(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

function fmtDate(iso) {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '\u2014';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const nodeKey = (libId, rel) => `${libId}::${rel}`;

// ---------- theme ----------

// Exactly three themes: Default (brand warm dark), Dark (true near-black),
// Light (true light). The stored choice sticks; otherwise Default.
const THEMES = ['default', 'dark', 'light'];

function applyTheme(theme, persist) {
  if (!THEMES.includes(theme)) theme = 'default';
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  const sel = $('#theme-select');
  if (sel) sel.value = theme;
  if (persist) {
    try { localStorage.setItem('av.theme', theme); } catch (_) { /* private mode */ }
  }
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('av.theme'); } catch (_) { /* private mode */ }
  applyTheme(saved || 'default', false);
}

// ---------- resizable panels ----------

function restoreLayout() {
  try {
    const sw = parseInt(localStorage.getItem('av.layout.sidebar'), 10);
    if (sw && sw >= 200) $('#sidebar').style.width = `${sw}px`;
    const dw = parseInt(localStorage.getItem('av.layout.detail'), 10);
    if (dw && dw >= 300) $('#detail').style.width = `${dw}px`;
  } catch (_) { /* ignore */ }
}

function makeResizer(handle, target, { invert = false, min = 200, max = 620, saveKey }) {
  let dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    document.body.classList.add('resizing');
    handle.classList.add('active');
    const startX = e.clientX;
    const startW = target.getBoundingClientRect().width;
    const onMove = (ev) => {
      if (!dragging) return;
      const dx = invert ? startX - ev.clientX : ev.clientX - startX;
      const w = Math.max(min, Math.min(max, startW + dx));
      target.style.width = `${w}px`;
    };
    const onUp = () => {
      dragging = false;
      document.body.classList.remove('resizing');
      handle.classList.remove('active');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try { localStorage.setItem(saveKey, target.style.width); } catch (_) { /* ignore */ }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

// ---------- boot ----------

async function init() {
  initTheme();
  restoreLayout();
  try {
    const info = await assetVault.getServerInfo();
    state.serverUrl = `http://${info.host}:${info.port}`;
  } catch (_) {
    setServerState(false);
    return;
  }
  state.libsMeta = (await assetVault.getState()).libraries || [];
  bindUi();
  schedule();
}

function setServerState(online) {
  state.online = online;
  $('#server-dot').className = `dot ${online ? 'online' : 'offline'}`;
  $('#server-state').textContent = online ? 'bridge: online' : 'bridge: offline';
  $('#btn-rescan').disabled = !online;
  renderUnityState();
}

// "Connected to a Unity project" = a Unity Editor plugin is actively polling
// the bridge (import-jobs every few seconds). True when a poll came in within
// ~15 s.
const UNITY_TIMEOUT_MS = 15000;

function renderUnityState() {
  const dot = $('#unity-dot');
  const label = $('#unity-state');
  if (!dot || !label) return;
  if (!state.online || !state.unityUp) {
    dot.className = 'dot offline';
    label.textContent = 'unity: not connected';
  } else {
    dot.className = 'dot unity';
    label.textContent = 'unity: connected';
  }
}

async function pollUnityStatus() {
  if (!state.serverUrl) return;
  try {
    const res = await fetch(`${state.serverUrl}/api/status`);
    const json = await res.json();
    const seen = json.unitySeenAt || 0;
    const up = seen > 0 && Date.now() - seen < UNITY_TIMEOUT_MS;
    if (up !== state.unityUp) {
      state.unityUp = up;
      renderUnityState();
    }
  } catch (_) { /* bridge offline; status indicators unchanged */ }
}

async function schedule() {
  await refreshLibrary();
  await pollJobs();
  await pollUnityStatus();
  renderUnityState();
  setInterval(pollJobs, 5000);
  setInterval(refreshLibrary, 20000);
  setInterval(pollUnityStatus, 5000);
}

async function refreshLibrary() {
  if (!state.serverUrl) return;
  try {
    const res = await fetch(`${state.serverUrl}/api/library`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'bad response');
    state.libraries = json.libraries || [];
    const tagsRes = await fetch(`${state.serverUrl}/api/tags`);
    const tagsJson = await tagsRes.json();
    state.tagData = tagsJson.ok ? tagsJson.tags || {} : {};
    const metaRes = await fetch(`${state.serverUrl}/api/meta`);
    const metaJson = await metaRes.json();
    const rawMeta = metaJson.ok ? metaJson.meta || {} : {};
    const metaMap = {};
    for (const k of Object.keys(rawMeta)) {
      const v = rawMeta[k];
      metaMap[k] = typeof v === 'string' ? v : (v && v.description) || '';
    }

    // scannedAt / serverTime change on every polling round; ignore them.
    const cleanLibraries = state.libraries.map((l) => ({ ...l, scannedAt: undefined }));
    const sig = JSON.stringify([cleanLibraries, state.tagData, metaMap]);
    const unchanged = sig === lastDataSig;
    state.metaData = metaMap;
    lastDataSig = sig;

    if (state.expanded.size === 0) {
      for (const lib of state.libraries) {
        state.expanded.add(`lib::${lib.id}`);
        const expandAll = (nodes) => {
          for (const node of nodes || []) {
            if (node.type === 'container') {
              state.expanded.add(nodeKey(lib.id, node.rel));
              expandAll(node.children);
            }
          }
        };
        expandAll(lib.tree);
      }
    }

    setServerState(true);

    // Nothing about the library/tags/descriptions changed, so keep the DOM
    // untouched instead of rebuilding (prevents the constant visible refresh).
    if (unchanged) return;

    ensureSelection();
    renderAll();
  } catch (err) {
    setServerState(false);
  }
}

async function pollJobs() {
  if (!state.serverUrl) return;
  try {
    const res = await fetch(`${state.serverUrl}/api/import-jobs`);
    const json = await res.json();
    if (!json.ok) return;
    const map = new Map();
    for (const job of json.jobs || []) map.set(job.assetId, job);

    let changed = map.size !== state.jobsByAsset.size;
    if (!changed) {
      for (const [id, job] of map) {
        const prev = state.jobsByAsset.get(id);
        if (!prev || prev.status !== job.status || prev.updatedAt !== job.updatedAt) { changed = true; break; }
      }
    }
    if (!changed) return;

    state.jobsByAsset = map;
    renderGrid();
    renderDetail();
  } catch (_) {
    /* bridge offline; status indicators unchanged */
  }
  await pollUnityStatus();
}

function ensureSelection() {
  if (!state.selectedAssetId) return;
  if (!findAssetById(state.selectedAssetId)) {
    const all = allAssets();
    state.selectedAssetId = all.length ? all[0].id : null;
  }
}

function allAssets() {
  const out = [];
  for (const lib of state.libraries) {
    for (const a of lib.assets || []) out.push({ ...a, _libId: lib.id, _lib: lib.name });
  }
  return out;
}

function findAssetById(id) {
  for (const lib of state.libraries) {
    for (const a of lib.assets || []) {
      if (a.id === id) return { ...a, _libId: lib.id, _lib: lib.name };
    }
  }
  return null;
}

function findLibById(id) {
  return state.libraries.find((l) => l.id === id) || null;
}

function findTreeNode(node, rel) {
  if (!node) return null;
  if (node.rel === rel) return node;
  for (const c of (node.children || [])) {
    const hit = findTreeNode(c, rel);
    if (hit) return hit;
  }
  return null;
}

function containerByRel(lib, rel) {
  for (const t of lib.tree || []) {
    const hit = findTreeNode(t, rel);
    if (hit && hit.type === 'container') return hit;
  }
  return null;
}

function inSubtree(relPath, containerRel) {
  return relPath === containerRel || relPath.startsWith(containerRel + '/');
}

// assetsFiltered({ includeTags }) => array of asset-with-lib decorated objects
function assetsFiltered(includeTags) {
  const q = state.search.trim().toLowerCase();
  const base = [];

  for (const lib of state.libraries) {
    if (state.activeLibId && lib.id !== state.activeLibId) continue;
    for (const a of lib.assets || []) {
      const decorated = { ...a, _libId: lib.id, _lib: lib.name };

      if (state.activeNode && !inSubtree(a.relPath, state.activeNode.rel)) continue;

      if (includeTags && state.activeTags.size) {
        let ok = true;
        for (const t of state.activeTags) {
          if (!(a.tags || []).includes(t)) { ok = false; break; }
        }
        if (!ok) continue;
      }

      if (q) {
        const nameHit = a.name.toLowerCase().includes(q);
        const tagHit = (a.tags || []).some((t) => t.includes(q));
        const descHit = (state.metaData[a.folder] || '').toLowerCase().includes(q);
        if (!nameHit && !tagHit && !descHit) continue;
      }

      base.push(decorated);
    }
  }
  base.sort((x, y) => x.name.localeCompare(y.name));
  return base;
}

// ---------- render ----------

function refresh() {
  renderSidebar();
  renderViewHead();
  renderGrid();
  renderDetail();
}

function renderAll() {
  window.__pvRenders = (window.__pvRenders || 0) + 1; // dev/diag metric
  renderSidebar();
  renderViewHead();
  renderGrid();
  renderDetail();
}

function renderSidebar() {
  const list = $('#lib-list');
  list.innerHTML = '';
  const libs = state.libsMeta.length ? state.libsMeta : state.libraries.map((l) => ({ id: l.id, name: l.name, path: l.path }));
  $('#sidebar-empty').style.display = libs.length ? 'none' : 'block';

  for (const lib of libs) {
    const scan = state.libraries.find((l) => l.id === lib.id);
    const total = scan ? scan.totalAssets : 0;
    const isOpen = state.expanded.has(`lib::${lib.id}`);
    const item = el('div', 'lib' + (isOpen ? ' open' : ''));

    const head = el('div', 'lib-head');
    const chev = iconSpan('chevron');
    chev.classList.add('chevron');
    head.appendChild(chev);
    head.appendChild(el('span', 'name', lib.name));
    head.appendChild(el('span', 'count', `${total || ''}`));
    if (lib.missing) head.appendChild(el('span', 'missing', 'path missing'));
    const rem = el('button', 'remove', '\u00D7', 'Remove library');
    rem.setAttribute('aria-label', `Remove library ${lib.name}`);
    rem.addEventListener('click', async (e) => {
      e.stopPropagation();
      await assetVault.removeLibrary(lib.id);
      state.activeLibId = null;
      state.activeNode = null;
      state.detail = null;
      state.libsMeta = (await assetVault.getState()).libraries || [];
      await refreshLibrary();
    });
    head.appendChild(rem);
    head.addEventListener('click', () => {
      const k = `lib::${lib.id}`;
      const opening = !state.expanded.has(k);
      if (opening) {
        state.expanded.add(k);
        state.activeLibId = lib.id;
        state.activeNode = null;
        state.selectedAssetId = null;
        state.detail = { kind: 'library', libId: lib.id };
      } else {
        state.expanded.delete(k);
        if (state.activeLibId === lib.id) {
          state.activeLibId = null;
          state.activeNode = null;
          state.detail = null;
        }
      }
      refresh();
    });
    item.appendChild(head);

    const wrap = el('div', 'lib-cats');
    if (scan) {
      const rows = el('div', 'tree');
      for (const node of scan.tree || []) renderTreeRow(node, lib.id, rows, 0);
      wrap.appendChild(rows);
    } else {
      wrap.appendChild(el('div', 'empty-hint', lib.missing ? 'folder not found' : 'scanning\u2026'));
    }
    item.appendChild(wrap);
    list.appendChild(item);
  }
}

function renderTreeRow(node, libId, parent, depth) {
  const key = nodeKey(libId, node.rel);
  const expanded = node.type === 'container' && state.expanded.has(key);
  const selected = isNodeSelected(libId, node.rel) || (node.type === 'asset' && node.asset.id === state.selectedAssetId);
  const row = el('div', 'tree-row'
    + (node.type === 'asset' ? ' asset-row' : '')
    + (expanded ? ' open' : '')
    + (selected ? ' selected' : ''));
  row.style.paddingLeft = `calc(10px + ${depth} * 20px)`;
  row.tabIndex = 0;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-expanded', node.type === 'container' ? String(expanded) : null);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      row.click();
    }
  });

  if (node.type === 'container') {
    const caret = el('button', 'tree-caret', null, 'Expand / collapse');
    caret.setAttribute('aria-label', `Expand / collapse ${node.name}`);
    caret.appendChild(iconSpan('chevron', 'caret-chevron'));
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleContainer(key);
    });
    row.appendChild(caret);
    const fi = iconSpan('folder');
    fi.classList.add('tree-icon');
    row.appendChild(fi);
    row.appendChild(el('span', 'tree-name', node.name));
    row.appendChild(el('span', 'tree-count', String(node.count)));
    row.addEventListener('click', () => {
      state.activeLibId = libId;
      state.activeNode = { libId, rel: node.rel };
      state.selectedAssetId = null;
      state.detail = { kind: 'container', libId, rel: node.rel };
      refresh();
    });
  } else {
    const spacer = el('span', 'tree-caret spacer', '');
    spacer.setAttribute('aria-hidden', 'true');
    row.appendChild(spacer);
    const ci = iconSpan('cube');
    ci.classList.add('tree-icon', 'asset-icon');
    row.appendChild(ci);
    row.appendChild(el('span', 'tree-name', node.name));
    row.addEventListener('click', () => {
      state.activeLibId = libId;
      state.activeNode = { libId, rel: node.rel };
      state.selectedAssetId = node.asset.id;
      state.detail = { kind: 'asset', libId, assetId: node.asset.id };
      refresh();
    });
  }
  parent.appendChild(row);

  if (node.type === 'container' && state.expanded.has(key)) {
    for (const child of node.children || []) renderTreeRow(child, libId, parent, depth + 1);
  }
}

function toggleContainer(key) {
  if (state.expanded.has(key)) state.expanded.delete(key);
  else state.expanded.add(key);
  renderSidebar();
}

function isNodeSelected(libId, rel) {
  if (!state.activeNode) return false;
  return state.activeNode.libId === libId && state.activeNode.rel === rel;
}

// ---------- view header ----------

function renderViewHead() {
  const bc = $('#breadcrumb');
  bc.innerHTML = '';
  const stats = el('span', 'stats', '');

  if (!state.activeLibId && !state.activeNode) {
    bc.appendChild(el('span', 'crumb current', 'All libraries'));
    stats.textContent = `${countVisible()} assets`;
  } else {
    const libId = state.activeNode ? state.activeNode.libId : state.activeLibId;
    const scan = findLibById(libId);
    const libName = scan ? scan.name : (state.libsMeta.find((m) => m.id === libId) || {}).name || 'Library';

    const libCrumb = el('span', 'crumb' + (state.activeNode ? '' : ' current'), libName);
    libCrumb.addEventListener('click', () => {
      state.activeLibId = libId;
      state.activeNode = null;
      state.selectedAssetId = null;
      state.detail = { kind: 'library', libId };
      refresh();
    });
    bc.appendChild(libCrumb);

    if (state.activeNode) {
      const parts = state.activeNode.rel.split('/').filter(Boolean);
      let acc = '';
      for (let i = 0; i < parts.length; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        const isLast = i === parts.length - 1;
        bc.appendChild(el('span', 'crumb-sep', '\u203A'));
        const seg = el('span', 'crumb' + (isLast ? ' current' : ''), parts[i]);
        if (!isLast) {
          seg.addEventListener('click', () => {
            state.activeNode = { libId, rel: acc };
            state.selectedAssetId = null;
            state.detail = { kind: 'container', libId, rel: acc };
            refresh();
          });
        }
        bc.appendChild(seg);
      }
    }
    stats.textContent = `${countVisible()} of ${scan ? scan.totalAssets : 0} assets`;
  }
  bc.appendChild(stats);

  renderTagFilter();
  renderFilterBadge();
  renderTagPopover();
}

function countVisible() {
  return assetsFiltered(true).length;
}

function allTagsInView() {
  const set = new Set();
  for (const a of assetsFiltered(false)) {
    for (const t of a.tags || []) set.add(t);
  }
  return Array.from(set).sort();
}

function toggleTag(t) {
  if (state.activeTags.has(t)) state.activeTags.delete(t);
  else state.activeTags.add(t);
  renderViewHead();
  renderGrid();
  renderDetail();
}

function renderTagFilter() {
  const bar = $('#tag-filter');
  bar.innerHTML = '';
  const tags = allTagsInView();
  if (!tags.length && state.activeTags.size === 0) return;

  bar.appendChild(el('span', 'label', 'Filter:'));
  const capped = tags.slice(0, 60);
  for (const t of capped) {
    const chip = el('span', 'tag-chip' + (state.activeTags.has(t) ? ' active' : ''), t);
    chip.addEventListener('click', () => toggleTag(t));
    bar.appendChild(chip);
  }
  if (state.activeTags.size) {
    const clear = el('span', 'tag-chip clear-all', `clear (${state.activeTags.size})`);
    clear.addEventListener('click', () => {
      state.activeTags.clear();
      renderViewHead();
      renderGrid();
      renderDetail();
    });
    bar.appendChild(clear);
  }
}

function renderFilterBadge() {
  const c = $('#filter-count');
  if (!c) return;
  c.textContent = state.activeTags.size ? String(state.activeTags.size) : '';
}

function renderTagPopover() {
  const pop = $('#tag-popover');
  if (!pop || pop.hidden) return;
  pop.innerHTML = '';
  const tags = allTagsInView();
  if (!tags.length) {
    pop.appendChild(el('div', 'popover-empty', 'No tags yet \u2014 add tags from an asset\u2019s details.'));
    return;
  }
  const visible = assetsFiltered(false);
  for (const t of tags) {
    const count = visible.filter((a) => (a.tags || []).includes(t)).length;
    const row = el('button', 'pop-row' + (state.activeTags.has(t) ? ' on' : ''), '');
    const check = el('span', 'pop-check', state.activeTags.has(t) ? '\u2713' : '');
    const name = el('span', 'pop-tag', t);
    const cnt = el('span', 'pop-count', String(count));
    row.append(check, name, cnt);
    row.addEventListener('click', () => {
      toggleTag(t);
      renderFilterBadge();
      renderTagPopover();
    });
    pop.appendChild(row);
  }
  if (state.activeTags.size) {
    const clear = el('button', 'pop-row pop-clear', '');
    clear.textContent = `Clear filters (${state.activeTags.size})`;
    clear.addEventListener('click', () => {
      state.activeTags.clear();
      renderViewHead();
      renderGrid();
      renderDetail();
      renderFilterBadge();
      renderTagPopover();
    });
    pop.appendChild(clear);
  }
}

function initTagPopover() {
  const btn = $('#btn-tag-filter');
  const pop = $('#tag-popover');
  if (!btn || !pop) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = pop.classList.contains('hidden');
    pop.classList.toggle('hidden', !willOpen);
    if (willOpen) renderTagPopover();
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', (e) => {
    if (e.target !== btn && !pop.contains(e.target)) pop.classList.add('hidden');
  });
}

// ---------- grid ----------

function previewUrl(path) {
  return path ? `${state.serverUrl}/api/preview?path=${encodeURIComponent(path)}` : null;
}

function jobForAsset(asset) {
  return state.jobsByAsset.get(asset.id);
}

function renderGrid() {
  const grid = $('#grid');
  const assets = assetsFiltered(true);
  grid.innerHTML = '';
  const empty = $('#empty-state');
  if (!assets.length) {
    empty.classList.add('visible');
    empty.textContent = state.libsMeta.length
      ? 'No assets match the current folder / tags / search.'
      : 'Add a library to start browsing assets.';
    return;
  }
  empty.classList.remove('visible');
  empty.textContent = '';

  assets.forEach((a, i) => {
    const card = el('div', 'card' + (a.id === state.selectedAssetId ? ' selected' : ''));
    card.style.animationDelay = `${Math.min((i % 12) * 16, 180)}ms`;
    const thumb = el('div', 'thumb');
    const url = previewUrl(a.preview && a.preview.path);
    if (url) {
      const img = el('img');
      img.src = url;
      img.loading = 'lazy';
      img.draggable = false;
      img.addEventListener('error', () => img.replaceWith(el('div', 'no-image', a.name[0].toUpperCase())));
      thumb.appendChild(img);
    } else {
      thumb.appendChild(el('div', 'no-image', a.name[0].toUpperCase()));
    }

    const badges = el('div', 'badges');
    const job = jobForAsset(a);
    if (job) {
      if (job.status === 'done') badges.appendChild(el('span', 'badge job-done', 'imported'));
      else if (job.status === 'failed') badges.appendChild(el('span', 'badge job-failed', 'failed'));
      else badges.appendChild(el('span', `badge job-${job.status}`, job.status === 'processing' ? 'importing' : 'queued'));
    } else if (a.importable) {
      badges.appendChild(el('span', 'badge importable', 'importable'));
    } else if (a.kinds.length) {
      badges.appendChild(el('span', 'badge', a.kinds.join(' \u00B7 ')));
    }
    thumb.appendChild(badges);
    card.appendChild(thumb);

    const body = el('div', 'card-body');
    body.appendChild(el('div', 'card-name', a.name));
    body.appendChild(el('div', 'card-meta', `${a.category || a.relPath} \u00B7 ${fmtBytes(a.sizeBytes)}`));
    if (a.tags && a.tags.length) {
      const tags = el('div', 'card-tags');
      for (const t of a.tags.slice(0, 3)) tags.appendChild(el('span', 'card-tag', t));
      if (a.tags.length > 3) tags.appendChild(el('span', 'card-tag', `+${a.tags.length - 3}`));
      body.appendChild(tags);
    }
    card.appendChild(body);

    card.addEventListener('click', () => {
      state.selectedAssetId = a.id;
      state.detail = { kind: 'asset', libId: a._libId, assetId: a.id };
      document.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      renderDetail();
    });
    grid.appendChild(card);
  });
}

// ---------- detail ----------

function detailTarget() {
  if (state.detail && state.detail.kind === 'asset') {
    const a = findAssetById(state.detail.assetId);
    if (a) return { kind: 'asset', asset: a, label: 'Asset' };
  }
  if (state.detail && state.detail.kind === 'container') {
    const scan = findLibById(state.detail.libId);
    const node = scan && containerByRel(scan, state.detail.rel);
    if (scan && node) return { kind: 'container', node, scan, label: 'Folder' };
  }
  if (state.detail && state.detail.kind === 'library') {
    const scan = findLibById(state.detail.libId);
    if (scan) {
      const meta = state.libsMeta.find((m) => m.id === scan.id);
      return { kind: 'library', scan, addedAt: meta && meta.addedAt, label: 'Library' };
    }
  }
  const a = findAssetById(state.selectedAssetId);
  if (a) return { kind: 'asset', asset: a, label: 'Asset' };
  return null;
}

function renderDetail() {
  const nobody = $('#detail-nobody');
  const content = $('#detail-content');
  const target = detailTarget();

  if (!target) {
    nobody.style.display = 'block';
    content.classList.add('hidden');
    $('#detail-title').textContent = 'Details';
    return;
  }
  nobody.style.display = 'none';
  content.classList.remove('hidden');
  $('#detail-title').textContent = target.label;
  content.dataset.view = target.kind;
  content.innerHTML = '';

  if (target.kind === 'asset') renderAssetDetail(content, target.asset);
  else if (target.kind === 'container') renderContainerDetail(content, target);
  else renderLibraryDetail(content, target);
}

function buildMetaGrid(rows) {
  const grid = el('div', 'meta-grid');
  for (const [label, value] of rows) {
    const r = el('div', 'meta-row');
    r.appendChild(el('span', 'meta-label', label));
    r.appendChild(el('span', 'meta-value', value || '\u2014'));
    grid.appendChild(r);
  }
  return grid;
}

function buildKindPills(kindCounts) {
  const wrap = el('div', 'kind-pills');
  for (const k of Object.keys(kindCounts || {}).sort()) {
    wrap.appendChild(el('span', 'kind-pill', `${k}${kindCounts[k] > 1 ? ` \u00D7${kindCounts[k]}` : ''}`));
  }
  return wrap;
}

function buildReadonlyTags(tags) {
  const wrap = el('div', 'detail-tags readonly-tags');
  for (const t of (tags || []).slice(0, 40)) {
    const chip = el('span', 'tag-chip' + (state.activeTags.has(t) ? ' active' : ''), t);
    chip.addEventListener('click', () => toggleTag(t));
    wrap.appendChild(chip);
  }
  if ((tags || []).length > 40) wrap.appendChild(el('span', 'sub', `+${tags.length - 40} more`));
  return wrap;
}

function buildDescriptionEditor(targetPath) {
  const wrap = el('div', 'desc-editor');
  wrap.appendChild(el('div', 'detail-section-title', 'Description'));
  const ta = el('textarea');
  ta.placeholder = 'Add a description\u2026';
  ta.value = state.metaData[targetPath] || '';
  const status = el('div', 'desc-status', '');
  wrap.appendChild(ta);
  wrap.appendChild(status);

  const before = (state.metaData[targetPath] || '').trim();
  const save = () => {
    const value = ta.value.trim();
    if (value === before) {
      status.textContent = '';
      return;
    }
    status.textContent = 'saving\u2026';
    putMeta(targetPath, value).then((ok) => {
      status.textContent = ok ? 'saved' : 'error';
      status.classList.toggle('ok', ok);
    });
  };
  ta.addEventListener('blur', save);
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      ta.blur();
    }
  });
  return wrap;
}

function pathFooter(p) {
  const f = el('div', 'path-footer', p);
  return f;
}

function renderAssetDetail(content, asset) {
  const url = previewUrl(asset.preview && asset.preview.path);
  if (url) {
    const box = el('div', 'preview');
    const img = el('img');
    img.src = url;
    img.draggable = false;
    box.appendChild(img);
    content.appendChild(box);
  } else {
    content.appendChild(el('div', 'preview no-image', asset.name[0].toUpperCase()));
  }

  content.appendChild(el('h2', '', asset.name));
  content.appendChild(el('div', 'sub', `${asset.category || asset.relPath} \u00B7 ${asset.fileCount} files \u00B7 ${fmtBytes(asset.sizeBytes)}`));

  content.appendChild(buildMetaGrid([
    ['Created', fmtDate(asset.created)],
    ['Modified', fmtDate(asset.updated)],
    ['Files', String(asset.fileCount || 0)],
    ['Size', fmtBytes(asset.sizeBytes)],
    ['Importable', asset.importable ? 'yes' : 'no'],
  ]));

  if (asset.kinds && asset.kinds.length) {
    content.appendChild(el('div', 'detail-section-title', 'Detected types'));
    const pills = el('div', 'kind-pills');
    for (const k of asset.kinds) pills.appendChild(el('span', 'kind-pill', k));
    content.appendChild(pills);
  }

  const job = jobForAsset(asset);
  const btn = el('button', 'import-btn', 'Import to Unity', 'Send this asset to the Unity Editor');
  if (!asset.importable) {
    btn.disabled = true;
    btn.title = 'Nothing importable found in this asset folder';
    btn.textContent = 'Nothing importable';
  }
  if (job) {
    btn.disabled = true;
    if (job.status === 'done') { btn.classList.add('done'); btn.textContent = 'Imported'; }
    else if (job.status === 'failed') { btn.classList.add('failed'); btn.textContent = 'Import failed'; }
    else if (job.status === 'processing') { btn.classList.add('queued'); btn.textContent = 'Importing in Unity...'; }
    else { btn.classList.add('queued'); btn.textContent = 'Queued - waiting for Unity'; }
  }
  btn.addEventListener('click', () => sendImportJob(asset));
  content.appendChild(btn);

  if (job && job.status !== 'pending') {
    const js = el('div', `job-state ${job.status === 'done' ? 'done' : job.status === 'failed' ? 'failed' : 'queued'}`);
    js.textContent = job.status === 'done'
      ? `Imported ${new Date(job.updatedAt).toLocaleTimeString()}`
      : job.status === 'failed'
        ? `Failed: ${job.note || 'unknown reason'}`
        : `Importing since ${new Date(job.updatedAt).toLocaleTimeString()}`;
    content.appendChild(js);
  }

  if (asset.importables && asset.importables.length) {
    content.appendChild(el('div', 'detail-section-title', 'Importable files'));
    const list = el('ul', 'file-list');
    for (const f of asset.importables) {
      list.appendChild(el('li', 'importable-file', `${f.name}  \u2014  ${f.rel}`));
    }
    content.appendChild(list);
  }

  content.appendChild(el('div', 'detail-section-title', 'Tags'));
  content.appendChild(buildTagEditor(asset));

  content.appendChild(buildDescriptionEditor(asset.folder));

  content.appendChild(pathFooter(asset.folder));
}

function renderContainerDetail(content, { node, scan }) {
  const head = el('div', 'detail-head');
  head.appendChild(el('div', 'folder-glyph', (node.name[0] || '?').toUpperCase()));
  const tb = el('div', 'detail-title-block');
  tb.appendChild(el('h2', '', node.name));
  tb.appendChild(el('div', 'sub', node.rel));
  head.appendChild(tb);
  content.appendChild(head);

  content.appendChild(buildMetaGrid([
    ['Created', fmtDate(node.created)],
    ['Modified', fmtDate(node.updated)],
    ['Assets', String(node.assetCount || 0)],
    ['Files', String(node.fileCount || 0)],
    ['Size', fmtBytes(node.sizeBytes)],
  ]));

  if (node.kindCounts && Object.keys(node.kindCounts).length) {
    content.appendChild(el('div', 'detail-section-title', 'Detected asset types'));
    content.appendChild(buildKindPills(node.kindCounts));
  }

  if (node.tags && node.tags.length) {
    content.appendChild(el('div', 'detail-section-title', `Tags in subfolders (${node.tags.length})`));
    content.appendChild(buildReadonlyTags(node.tags));
  }

  content.appendChild(buildDescriptionEditor(node.path));

  content.appendChild(pathFooter(node.path));
}

function renderLibraryDetail(content, { scan, addedAt }) {
  const head = el('div', 'detail-head');
  head.appendChild(el('div', 'folder-glyph', (scan.name[0] || '?').toUpperCase()));
  const tb = el('div', 'detail-title-block');
  tb.appendChild(el('h2', '', scan.name));
  tb.appendChild(el('div', 'sub', scan.path));
  head.appendChild(tb);
  content.appendChild(head);

  content.appendChild(buildMetaGrid([
    ['Added', fmtDate(addedAt)],
    ['Last scan', fmtDate(scan.scannedAt)],
    ['Assets', String(scan.assetCount || 0)],
    ['Files', String(scan.fileCount || 0)],
    ['Size', fmtBytes(scan.sizeBytes)],
  ]));

  if (scan.kindCounts && Object.keys(scan.kindCounts).length) {
    content.appendChild(el('div', 'detail-section-title', 'Detected asset types'));
    content.appendChild(buildKindPills(scan.kindCounts));
  }

  if (scan.tags && scan.tags.length) {
    content.appendChild(el('div', 'detail-section-title', `Tags (${scan.tags.length})`));
    content.appendChild(buildReadonlyTags(scan.tags));
  }

  content.appendChild(buildDescriptionEditor(scan.path));

  content.appendChild(pathFooter(scan.path));
}

function buildTagEditor(asset) {
  const wrap = el('div', 'detail-tags');
  const render = () => {
    wrap.innerHTML = '';
    for (const t of asset.tags || []) {
      const chip = el('span', 'detail-tag', t);
      const rm = el('button', '', '\u00D7', `remove tag "${t}"`);
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        putTags(asset, (asset.tags || []).filter((x) => x !== t));
      });
      chip.appendChild(rm);
      wrap.appendChild(chip);
    }

    const row = el('div', 'tag-add-row');
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'add a tag\u2026';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        const next = [...(asset.tags || []), input.value.trim().toLowerCase()];
        putTags(asset, next);
        input.value = '';
      }
    });
    const add = el('button', '', '+');
    add.addEventListener('click', () => {
      if (input.value.trim()) {
        const next = [...(asset.tags || []), input.value.trim().toLowerCase()];
        putTags(asset, next);
        input.value = '';
      }
    });
    row.appendChild(input);
    row.appendChild(add);
    wrap.appendChild(row);
  };
  render();
  return wrap;
}

async function putTags(asset, tags) {
  const res = await fetch(`${state.serverUrl}/api/tags`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: asset.folder, tags }),
  });
  const json = await res.json();
  if (!json.ok) return;
  asset.tags = json.tags;
  state.tagData[asset.folder] = json.tags;
  renderDetail();
  renderGrid();
  renderViewHead();
}

async function putMeta(targetPath, description) {
  try {
    const res = await fetch(`${state.serverUrl}/api/meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: targetPath, description }),
    });
    const json = await res.json();
    if (!json.ok) return false;
    state.metaData[json.path] = json.description || '';
    return true;
  } catch (_) {
    return false;
  }
}

async function sendImportJob(asset) {
  if (!state.serverUrl) return;
  const payload = {
    assetId: asset.id,
    assetName: asset.name,
    category: asset.category,
    libraryName: asset.libraryName,
    assetFolder: asset.folder,
    tags: asset.tags || [],
    importables: asset.importables,
  };
  const res = await fetch(`${state.serverUrl}/api/import-job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (json.ok) {
    state.jobsByAsset.set(asset.id, json.job);
    renderDetail();
    renderGrid();
  }
}

// ---------- bindings ----------

function bindUi() {
  $('#btn-add-library').addEventListener('click', async () => {
    state.libsMeta = (await assetVault.addLibrary()).libraries || [];
    await refreshLibrary();
  });
  $('#btn-rescan').addEventListener('click', refreshLibrary);
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderGrid();
    renderViewHead();
  });
  $('#theme-select').addEventListener('change', (e) => {
    applyTheme(e.target.value, true);
  });
  initTagPopover();
  makeResizer($('#split-left'), $('#sidebar'), { min: 200, max: 520, saveKey: 'av.layout.sidebar' });
  makeResizer($('#split-right'), $('#detail'), { invert: true, min: 300, max: 620, saveKey: 'av.layout.detail' });
}

init().catch((err) => {
  setServerState(false);
  console.error('init failed', err);
});