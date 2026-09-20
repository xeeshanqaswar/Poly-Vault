'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// File-kind tables
// ---------------------------------------------------------------------------

// Preview images used on asset cards, listed by priority.
const PREVIEW_PRIORITY = ['.png', '.jpg', '.jpeg', '.webp'];

// Files that Unity can import directly. If an asset folder contains at least
// one of these, the "Import to Unity" action becomes available.
const IMPORTABLE_EXTENSIONS = new Set([
  // packages / scene / prefab artifacts
  '.unitypackage',
  '.prefab', '.scene',
  // meshes & models
  '.fbx', '.obj', '.glb', '.gltf', '.blend', '.dae', '.3ds', '.dxf', '.stl',
  '.max', '.c4d', '.mb', '.ma', '.abc', '.x', '.lwo', '.lws', '.ply',
  // textures / images
  '.png', '.jpg', '.jpeg', '.tga', '.psd', '.tif', '.tiff', '.bmp', '.gif',
  '.exr', '.hdr', '.dds', '.ktx', '.pvr',
  // fonts
  '.ttf', '.otf', '.dfont',
  // audio
  '.wav', '.mp3', '.ogg', '.aif', '.aiff', '.flac', '.xm', '.mod', '.it', '.s3m',
  // video
  '.mp4', '.mov', '.avi', '.webm', '.m4v', '.mpg', '.mpeg', '.asf', '.wmv',
  // animation / motion
  '.bvh', '.htr', '.anim', '.controller', '.overridecontroller',
  // materials / masks
  '.mat', '.spriteatlas', '.mask',
  // scripts / assemblies
  '.cs', '.dll', '.asmdef', '.asmref', '.shader', '.cginc', '.hlsl',
  // mixers / playables / fx artifacts
  '.mixer', '.playable', '.rendertexture', '.flare', '.halo', '.lighting',
]);

const MESH_EXTENSIONS = new Set([
  '.fbx', '.obj', '.glb', '.gltf', '.blend', '.dae', '.3ds', '.dxf', '.stl',
  '.max', '.c4d', '.mb', '.ma', '.abc', '.x', '.lwo', '.lws', '.ply',
]);

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.tga', '.psd', '.tif', '.tiff',
  '.bmp', '.exr', '.hdr', '.svg',
]);

const AUDIO_EXTENSIONS = new Set([
  '.wav', '.mp3', '.ogg', '.aif', '.aiff', '.flac', '.xm', '.mod', '.it', '.s3m',
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.avi', '.webm', '.m4v', '.mpg', '.mpeg', '.asf', '.wmv',
]);

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.dfont']);

const SCRIPT_EXTENSIONS = new Set(['.cs', '.dll', '.asmdef', '.asmref', '.shader', '.cginc', '.hlsl']);

const MATERIAL_EXTENSIONS = new Set(['.mat', '.mtl', '.physicmaterial', '.physicsmaterial']);

// Directories that are never treated as category/asset folders.
const IGNORED_DIR_NAMES = new Set([
  '.git', '.svn', '.hg', '.ds_store', 'node_modules', '__pycache__',
  'thumbs', 'thumbnails', 'previews', 'temp', 'tmp',
]);

const IGNORE_MARKERS = ['.nomedia', '.assetvault-ignore'];

const MAX_SCAN_DEPTH = 12;   // max sub-folder depth for nested assets
const MAX_SCAN_FILES = 4000; // safety cap per asset folder

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function readDirNames(p) {
  try { return fs.readdirSync(p); } catch (_) { return []; }
}

function hasIgnoreMarker(dir) {
  for (const marker of IGNORE_MARKERS) {
    if (fs.existsSync(path.join(dir, marker))) return true;
  }
  return false;
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function listFilesRecursive(rootDir, out = [], cap = MAX_SCAN_FILES, depth = 0, base = rootDir) {
  if (out.length >= cap || depth > MAX_SCAN_DEPTH) return out;
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= cap) break;
    if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      listFilesRecursive(full, out, cap, depth + 1, base);
    } else if (entry.isFile()) {
      out.push({
        name: entry.name,
        path: full,
        rel: path.relative(base, full).replace(/\\/g, '/'),
      });
    }
  }
  return out;
}

function isDepth0(f) {
  return f.rel.indexOf('/') === -1;
}

// ---------------------------------------------------------------------------
// Detection logic
// ---------------------------------------------------------------------------

function findPreviewImage(assetDir, files) {
  let best = null;
  let bestDepth = Infinity;
  let bestPriority = Infinity;
  for (const f of files) {
    const ext = path.extname(f.name).toLowerCase();
    const priority = PREVIEW_PRIORITY.indexOf(ext);
    if (priority === -1) continue;
    const depth = f.rel.indexOf('/') === -1 ? 0 : f.rel.split('/').length - 1;
    if (
      depth < bestDepth ||
      (depth === bestDepth &&
        (priority < bestPriority ||
          (priority === bestPriority && (!best || f.name.length < best.name.length))))
    ) {
      best = f;
      bestDepth = depth;
      bestPriority = priority;
    }
  }
  return best;
}

function classifyImportable(assetDir, files, excludePath = null) {
  const importables = [];
  for (const f of files) {
    if (excludePath && path.resolve(f.path) === path.resolve(excludePath)) continue;
    const ext = path.extname(f.name).toLowerCase();
    if (IMPORTABLE_EXTENSIONS.has(ext)) {
      importables.push({
        name: f.name,
        path: f.path,
        rel: f.rel,
        kind: ext.slice(1),
      });
    }
  }
  return importables;
}

function assetKind(importables) {
  if (importables.some((i) => i.kind === 'unitypackage')) return 'unitypackage';
  for (const i of importables) {
    if (MESH_EXTENSIONS.has(`.${i.kind}`)) return 'mesh';
  }
  if (importables.length > 0) return 'asset';
  return 'other';
}

// Compact display bucket for an importable file's extension (call with the
// lower-cased extension INCLUDING the dot, e.g. '.fbx').
function kindOfExt(ext) {
  if (ext === '.unitypackage') return 'unitypackage';
  if (MESH_EXTENSIONS.has(ext)) return 'mesh';
  if (IMAGE_EXTENSIONS.has(ext)) return 'texture';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (FONT_EXTENSIONS.has(ext)) return 'font';
  if (SCRIPT_EXTENSIONS.has(ext)) return 'script';
  if (MATERIAL_EXTENSIONS.has(ext)) return 'material';
  return ext ? ext.slice(1) : 'other';
}

function assetDisplayKinds(importables) {
  const kinds = new Set();
  for (const i of importables) kinds.add(kindOfExt(`.${i.kind}`));
  return Array.from(kinds).sort();
}

// Count of importable files per kind bucket: { mesh: 2, texture: 1, ... }.
function buildKindCounts(importables) {
  const kc = {};
  for (const i of importables) {
    const k = kindOfExt(`.${i.kind}`);
    kc[k] = (kc[k] || 0) + 1;
  }
  return kc;
}

function sizeOfDir(files) {
  let total = 0;
  for (const f of files) {
    try { total += fs.statSync(f.path).size; } catch (_) { /* ignore */ }
  }
  return total;
}

// Created / modified timestamps for a folder itself.
function statInfo(absPath) {
  try {
    const st = fs.statSync(absPath);
    return {
      created: st.birthtime && !isNaN(st.birthtime.getTime()) ? st.birthtime.toISOString() : null,
      updated: st.mtime ? st.mtime.toISOString() : null,
    };
  } catch (_) {
    return { created: null, updated: null };
  }
}

// Sums assets/files/bytes/kind-counts across a set of child nodes and returns
// the unique (sorted) tag set of every descendant asset.
function aggregateChildren(nodes) {
  const out = { assetCount: 0, fileCount: 0, sizeBytes: 0, kindCounts: {}, tags: new Set() };
  for (const n of nodes) {
    out.assetCount += n.type === 'asset' ? 1 : (n.assetCount || n.count || 0);
    out.fileCount += n.fileCount || 0;
    out.sizeBytes += n.sizeBytes || 0;
    for (const k in (n.kindCounts || {})) out.kindCounts[k] = (out.kindCounts[k] || 0) + n.kindCounts[k];
    for (const t of (n.tags || [])) out.tags.add(t);
  }
  out.tags = Array.from(out.tags).sort();
  return out;
}

// Latest modified time across child nodes, falling back to folder mtime.
function maxUpdated(nodes, fallback) {
  let best = fallback ? new Date(fallback).getTime() : 0;
  for (const n of nodes) {
    const t = n.updated ? new Date(n.updated).getTime() : 0;
    if (t > best) best = t;
  }
  return best ? new Date(best).toISOString() : fallback;
}

// ---------------------------------------------------------------------------
// Tree scanner
// ---------------------------------------------------------------------------

function sortByName(nodes) {
  nodes.sort((a, b) => a.name.localeCompare(b.name));
  for (const n of nodes) if (n.type === 'container') sortByName(n.children);
}

// Returns null when the folder should be ignored or contains no assets.
function scanDirectory(lib, absPath, rel, depth, getTags, getMeta) {
  const name = path.basename(absPath);
  if (depth > 0) {
    if (name.startsWith('.')) return null;
    if (IGNORED_DIR_NAMES.has(name.toLowerCase())) return null;
  }
  if (hasIgnoreMarker(absPath)) return null;

  let entries;
  try {
    entries = fs.readdirSync(absPath, { withFileTypes: true });
  } catch (_) {
    return null;
  }

  const dirs = [];
  const directFiles = [];
  for (const entry of entries) {
    const full = path.join(absPath, entry.name);
    if (entry.isDirectory()) {
      dirs.push(full);
    } else if (entry.isFile() && entry.name !== '.DS_Store' && entry.name !== 'Thumbs.db') {
      directFiles.push({ name: entry.name, path: full });
    }
  }

  const hasDirectPreview = directFiles.some(
    (f) => PREVIEW_PRIORITY.indexOf(path.extname(f.name).toLowerCase()) !== -1
  );
  const hasDirectImportable = directFiles.some(
    (f) => IMPORTABLE_EXTENSIONS.has(path.extname(f.name).toLowerCase())
  );

  // A folder only counts as an asset when something importable or a preview
  // image sits *directly* inside it. Otherwise it is a container that we
  // recurse into (so nested folders like 3d/Props/Furniture/Chair/ all work).
  if (hasDirectPreview || hasDirectImportable) {
    const files = listFilesRecursive(absPath);
    const preview = findPreviewImage(absPath, files);
    // The preview image doubles as display only; never count it as an
    // importable file.
    const importables = classifyImportable(absPath, files, preview && preview.path);
    const tags = getTags ? (Array.isArray(getTags(absPath)) ? getTags(absPath) : []) : [];
    const info = statInfo(absPath);

    return {
      type: 'asset',
      name,
      path: absPath,
      rel,
      count: 1,
      assetCount: 1,
      fileCount: files.length,
      sizeBytes: sizeOfDir(files),
      kindCounts: buildKindCounts(importables),
      tags,
      created: info.created,
      updated: info.updated,
      description: getMeta ? getMeta(absPath) || '' : '',
      children: [],
      asset: {
        id: `${lib.id}:${hashString(absPath)}`,
        name,
        relPath: rel,
        category: rel, // parent relative path; replaced with parent rel by flatten
        libraryId: lib.id,
        libraryName: lib.name,
        folder: absPath,
        sizeBytes: sizeOfDir(files),
        fileCount: files.length,
        kindCounts: buildKindCounts(importables),
        preview: preview ? { path: preview.path, rel: preview.rel } : null,
        importables,
        importable: importables.length > 0,
        kinds: assetDisplayKinds(importables),
        kind: assetKind(importables),
        tags,
        created: info.created,
        updated: info.updated,
        description: getMeta ? getMeta(absPath) || '' : '',
      },
    };
  }

  const children = [];
  for (const dir of dirs) {
    const childAbs = dir;
    const childName = path.basename(dir);
    const childRel = rel ? `${rel}/${childName}` : childName;
    const childNode = scanDirectory(lib, childAbs, childRel, depth + 1, getTags, getMeta);
    if (childNode) children.push(childNode);
  }
  if (children.length === 0) return null;

  const agg = aggregateChildren(children);
  const info = statInfo(absPath);

  return {
    type: 'container',
    name,
    path: absPath,
    rel,
    count: agg.assetCount,
    assetCount: agg.assetCount,
    fileCount: agg.fileCount,
    sizeBytes: agg.sizeBytes,
    kindCounts: agg.kindCounts,
    tags: agg.tags,
    created: info.created,
    updated: maxUpdated(children, info.updated),
    description: getMeta ? getMeta(absPath) || '' : '',
    children,
    asset: null,
  };
}

function flattenTree(nodes, out = []) {
  for (const node of nodes) {
    if (node.type === 'asset') {
      out.push(node.asset);
    } else {
      flattenTree(node.children, out);
    }
  }
  return out;
}

function setCategories(nodes, parentRel = '') {
  for (const node of nodes) {
    if (node.type === 'asset') {
      node.asset.category = parentRel;
    } else {
      setCategories(node.children, node.rel);
    }
  }
}

/**
 * Scans a library into a nested tree + flattened asset list.
 *
 * @param {object} lib          { id, name, path }
 * @param {object} [options]
 * @param {Function} [options.getTags] (absPath) => string[]
 * @param {Function} [options.getMeta] (absPath) => string (folders' descriptions)
 */
function scanLibrary(lib, options = {}) {
  const root = lib.path;
  const getTags = options.getTags || null;
  const getMeta = options.getMeta || null;

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return {
      id: lib.id, name: lib.name, path: lib.path, totalAssets: 0,
      assetCount: 0, fileCount: 0, sizeBytes: 0, kindCounts: {},
      created: null, updated: null, description: '',
      tree: [], assets: [], tags: [],
      scannedAt: new Date().toISOString(),
    };
  }

  const tree = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(root, entry.name);
    const node = scanDirectory(lib, abs, entry.name, 1, getTags, getMeta);
    if (node) tree.push(node);
  }
  sortByName(tree);
  setCategories(tree);

  const assets = flattenTree(tree);
  assets.sort((a, b) => a.name.localeCompare(b.name));

  const agg = aggregateChildren(tree);
  const info = statInfo(root);

  return {
    id: lib.id,
    name: lib.name,
    path: lib.path,
    totalAssets: assets.length,
    assetCount: assets.length,
    fileCount: agg.fileCount,
    sizeBytes: agg.sizeBytes,
    kindCounts: agg.kindCounts,
    tags: agg.tags,
    created: info.created,
    updated: maxUpdated(tree, info.updated),
    description: getMeta ? getMeta(root) || '' : '',
    tree,
    assets,
    scannedAt: new Date().toISOString(),
  };
}

module.exports = {
  PREVIEW_PRIORITY,
  IMPORTABLE_EXTENSIONS,
  MESH_EXTENSIONS,
  IMAGE_EXTENSIONS,
  scanLibrary,
  listFilesRecursive,
  hashString,
  isDir,
};