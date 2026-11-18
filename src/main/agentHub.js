'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Local MCP endpoint for coding agents (Claude Code, Codex, Cursor, ...).
// Agents connect to POST /mcp on the same loopback bridge the Unity plugin
// uses; no data leaves the machine. Exports copy files into a project folder
// the agent names, and every session/export is surfaced in the desktop UI.

const PROTOCOL_VERSION = '2025-06-18';
const MAX_EXPORTS = 200;
const AGENT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_EXPORT_FILES = 2000;
const MAX_RECORDED_FILES = 200;
const MAX_COPY_BYTES = 2 * 1024 * 1024 * 1024;
const IGNORED_MARKERS = new Set(['.assetvault-ignore', '.nomedia', '.DS_Store', 'Thumbs.db']);

class AgentError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AgentError';
    this.code = code || 'invalid_request';
  }
}

function normalizeKey(p) {
  return path.resolve(p).toLowerCase();
}

function isWithin(target, root) {
  const t = normalizeKey(target);
  const r = normalizeKey(root);
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

function protectedRoots() {
  return ['WINDIR', 'SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)']
    .map((key) => process.env[key])
    .filter(Boolean);
}

function assertDestination(raw, libraries) {
  if (!raw || typeof raw !== 'string') throw new AgentError('destination is required');
  if (!path.isAbsolute(raw)) throw new AgentError('destination must be an absolute path');
  const resolved = path.resolve(raw);
  if (path.parse(resolved).root === resolved) {
    throw new AgentError('destination cannot be a filesystem root');
  }
  for (const root of protectedRoots()) {
    if (isWithin(resolved, root)) throw new AgentError('destination is a protected system folder');
  }
  for (const lib of libraries) {
    if (isWithin(resolved, lib.path)) throw new AgentError('destination is inside a Poly Vault library');
  }
  return resolved;
}

function sanitizeSubfolder(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string') throw new AgentError('subfolder must be a string');
  if (path.isAbsolute(raw)) throw new AgentError('subfolder must be relative');
  const parts = raw.split(/[\\/]+/).filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new AgentError('subfolder cannot escape the destination');
  return path.join(...parts);
}

function walkFiles(root, out = [], budget = { files: 0 }) {
  if (budget.files >= MAX_EXPORT_FILES) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    if (budget.files >= MAX_EXPORT_FILES) break;
    if (IGNORED_MARKERS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, out, budget);
    else if (entry.isFile()) {
      out.push(full);
      budget.files += 1;
    }
  }
  return out;
}

function collectSources(asset) {
  const importables = (asset.importables || []).filter(
    (item) => item && typeof item.path === 'string' && fs.existsSync(item.path)
  );
  if (importables.length) {
    return importables.map((item) => ({
      path: item.path,
      rel: item.rel && !path.isAbsolute(item.rel) ? item.rel : path.basename(item.path),
    }));
  }
  return walkFiles(asset.folder).map((full) => ({
    path: full,
    rel: path.relative(asset.folder, full),
  }));
}

function assetSummary(asset, library) {
  return {
    assetId: asset.id,
    name: asset.name,
    libraryId: asset.libraryId,
    libraryName: library ? library.name : asset.libraryName,
    kind: asset.kind,
    kinds: asset.kinds || [],
    tags: asset.tags || [],
    importable: !!asset.importable,
    fileCount: asset.fileCount,
    sizeBytes: asset.sizeBytes,
    folder: asset.folder,
    description: asset.description || '',
  };
}

function matchesQuery(asset, query) {
  if (!query) return true;
  const needle = String(query).toLowerCase();
  const haystack = [
    asset.name,
    asset.category,
    asset.relPath,
    asset.kind,
    ...(asset.kinds || []),
    ...(asset.tags || []),
    asset.description || '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

function flattenAssets(libraries) {
  const out = [];
  for (const lib of libraries) {
    for (const asset of lib.assets || []) out.push({ asset, library: lib });
  }
  return out;
}

function resolveAsset(libraries, args) {
  const all = flattenAssets(libraries);
  if (!all.length) throw new AgentError('no assets indexed yet - add a library in Poly Vault');

  const libraryId = args.libraryId ? String(args.libraryId) : null;
  const scoped = libraryId ? all.filter((entry) => entry.library.id === libraryId) : all;
  if (libraryId && !scoped.length) throw new AgentError(`unknown libraryId: ${libraryId}`, 'not_found');

  if (args.assetId) {
    const hit = scoped.find((entry) => entry.asset.id === String(args.assetId));
    if (!hit) throw new AgentError(`unknown assetId: ${args.assetId}`, 'not_found');
    return hit;
  }

  if (!args.name || typeof args.name !== 'string') {
    throw new AgentError('provide assetId or name');
  }
  const needle = args.name.trim().toLowerCase();
  const hits = scoped.filter((entry) => entry.asset.name.toLowerCase() === needle);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new AgentError(
      `asset name "${args.name}" is ambiguous - pass assetId or libraryId (matches: ${hits
        .map((h) => h.asset.id)
        .join(', ')})`,
      'ambiguous'
    );
  }
  const partial = scoped.filter((entry) => entry.asset.name.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new AgentError(
      `no exact asset named "${args.name}" - narrow it down (matches: ${partial
        .slice(0, 5)
        .map((h) => `${h.asset.name} [${h.asset.id}]`)
        .join(', ')})`,
      'ambiguous'
    );
  }
  throw new AgentError(`no asset found for "${args.name}"`, 'not_found');
}

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function toolResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

const TOOLS = [
  {
    name: 'poly_vault_list_libraries',
    description:
      'List the asset libraries registered in Poly Vault, with asset counts and filesystem roots.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'poly_vault_search_assets',
    description:
      'Search indexed assets by free text (name, category, tags, description). Returns compact asset summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query. Omit to list assets.' },
        libraryId: { type: 'string' },
        kind: { type: 'string', description: 'mesh, texture, audio, unitypackage, ...' },
        tag: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'poly_vault_get_asset',
    description:
      'Get one asset by assetId or exact name: description, tags, importable files and preview path.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string' },
        name: { type: 'string' },
        libraryId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'poly_vault_export_asset',
    description:
      'Copy an asset into a project folder on disk. Importable files are copied; assets without importables copy their folder contents. Refuses destinations inside a Poly Vault library or a system folder.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string' },
        name: { type: 'string' },
        libraryId: { type: 'string' },
        destination: {
          type: 'string',
          description: 'Absolute path of the project folder to copy into.',
        },
        subfolder: {
          type: 'string',
          description: 'Relative subfolder under destination (e.g. "Assets/ThirdParty").',
        },
        flatten: {
          type: 'boolean',
          description: 'Copy files directly into destination instead of destination/<asset name>.',
        },
        overwrite: { type: 'boolean', description: 'Replace files that already exist.' },
      },
      required: ['destination'],
      additionalProperties: false,
    },
  },
  {
    name: 'poly_vault_list_exports',
    description: 'List recent agent exports recorded by Poly Vault.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
  },
];

/**
 * @param {object} deps
 * @param {() => Array} deps.scanAll        full library scans (tree + assets)
 * @param {() => Array} deps.getLibraries   [{id,name,path}]
 * @param {() => string} deps.getVersion
 * @param {string} deps.mcpUrl
 * @param {{getAll:()=>Array, add:(record:object)=>void}} deps.exports
 */
function createAgentHub({ scanAll, getLibraries, getVersion, mcpUrl, exports }) {
  const sessions = new Map();
  let exportsCache = [];

  const now = () => Date.now();

  function touch(sessionId, client, tool) {
    let session = sessionId ? sessions.get(sessionId) || null : null;
    // Clients normally echo Mcp-Session-Id; when one doesn't, keep its calls on
    // the most recently active session instead of inventing a new agent row.
    if (!session && !client && sessions.size) {
      session = Array.from(sessions.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
    }
    const id = session ? session.id : sessionId || crypto.randomUUID();
    const at = now();
    if (!session) {
      session = {
        id,
        name: (client && client.name) || 'Unknown agent',
        version: (client && client.version) || '',
        connectedAt: at,
        lastSeenAt: at,
        calls: 0,
        lastTool: '',
        tools: {},
      };
      sessions.set(id, session);
    }
    session.lastSeenAt = at;
    if (client && client.name) session.name = client.name;
    if (client && client.version) session.version = client.version;
    if (tool) {
      session.calls += 1;
      session.lastTool = tool;
      session.tools[tool] = (session.tools[tool] || 0) + 1;
    }
    return session;
  }

  function closeSession(sessionId) {
    if (sessionId) sessions.delete(sessionId);
  }

  function recordExport(record) {
    exports.add(record);
    exportsCache = exports.getAll();
    if (exportsCache.length > MAX_EXPORTS) exportsCache = exportsCache.slice(-MAX_EXPORTS);
  }

  function exportAsset(args, session) {
    const libraries = scanAll();
    const { asset, library } = resolveAsset(libraries, args);
    const destination = assertDestination(args.destination, getLibraries());
    const subfolder = sanitizeSubfolder(args.subfolder);
    const root = path.join(destination, subfolder);
    const flatten = args.flatten === true;
    const overwrite = args.overwrite === true;

    if (asset.folder && isWithin(root, asset.folder)) {
      throw new AgentError('destination cannot be the asset folder itself or inside it');
    }
    fs.mkdirSync(root, { recursive: true });

    const sources = collectSources(asset);
    const files = [];
    const skippedFiles = [];
    let copied = 0;
    let skipped = 0;
    let bytes = 0;
    const seenTargets = new Set();

    for (const source of sources) {
      if (copied + skipped >= MAX_EXPORT_FILES) break;
      if (!fs.existsSync(source.path) || !fs.statSync(source.path).isFile()) {
        skipped += 1;
        continue;
      }
      const rel = flatten ? path.basename(source.path) : path.join(asset.name, source.rel || path.basename(source.path));
      const target = path.join(root, rel);
      if (!isWithin(target, root)) {
        skipped += 1;
        continue;
      }
      const targetKey = normalizeKey(target);
      if (seenTargets.has(targetKey)) {
        skipped += 1;
        continue;
      }
      seenTargets.add(targetKey);
      if (fs.existsSync(target) && !overwrite) {
        skipped += 1;
        skippedFiles.push(target);
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source.path, target);
      const size = fs.statSync(target).size;
      bytes += size;
      if (bytes > MAX_COPY_BYTES) throw new AgentError('export exceeds the 2 GB safety limit');
      files.push(target);
      copied += 1;
    }

    const record = {
      id: crypto.randomUUID(),
      assetId: asset.id,
      assetName: asset.name,
      libraryId: library ? library.id : asset.libraryId,
      libraryName: library ? library.name : asset.libraryName,
      destination: root,
      fileCount: files.length,
      copied,
      skipped,
      bytes,
      flatten,
      status: copied > 0 ? 'done' : 'skipped',
      files: files.slice(0, MAX_RECORDED_FILES),
      skippedFiles: skippedFiles.slice(0, MAX_RECORDED_FILES),
      createdAt: new Date().toISOString(),
      agent: session ? { name: session.name, version: session.version } : null,
    };
    recordExport(record);
    return {
      ...record,
      asset: assetSummary(asset, library),
      hint:
        copied > 0
          ? `Copied ${copied} file(s) into ${root}`
          : 'Nothing copied - every target file already exists (pass overwrite: true to replace).',
    };
  }

  async function callTool(name, args, session) {
    const libraries = scanAll();
    switch (name) {
      case 'poly_vault_list_libraries':
        return {
          libraries: libraries.map((lib) => ({
            libraryId: lib.id,
            name: lib.name,
            path: lib.path,
            assetCount: (lib.assets || []).length,
            fileCount: lib.fileCount,
          })),
        };

      case 'poly_vault_search_assets': {
        const limit = clampLimit(args.limit);
        const kind = args.kind ? String(args.kind).toLowerCase() : null;
        const tag = args.tag ? String(args.tag).toLowerCase() : null;
        const libraryId = args.libraryId ? String(args.libraryId) : null;
        const hits = [];
        for (const { asset, library } of flattenAssets(libraries)) {
          if (libraryId && library.id !== libraryId) continue;
          if (kind && asset.kind !== kind && !(asset.kinds || []).includes(kind)) continue;
          if (tag && !(asset.tags || []).includes(tag)) continue;
          if (!matchesQuery(asset, args.query)) continue;
          hits.push(assetSummary(asset, library));
        }
        return { total: hits.length, returned: hits.slice(0, limit), query: args.query || '' };
      }

      case 'poly_vault_get_asset': {
        const { asset, library } = resolveAsset(libraries, args);
        return {
          ...assetSummary(asset, library),
          category: asset.category,
          created: asset.created,
          updated: asset.updated,
          preview: asset.preview || null,
          importables: (asset.importables || []).map((item) => ({
            name: item.name,
            rel: item.rel,
            kind: item.kind,
            path: item.path,
          })),
        };
      }

      case 'poly_vault_export_asset':
        return exportAsset(args, session);

      case 'poly_vault_list_exports': {
        const limit = clampLimit(args.limit);
        return { exports: exportsCache.slice(-limit).reverse() };
      }

      default:
        throw new AgentError(`unknown tool: ${name}`, 'method_not_found');
    }
  }

  async function handleMessage(message, sessionId) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return { payload: rpcError(message && message.id, -32600, 'invalid request'), sessionId };
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const id = message.id;

    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { payload: rpcError(id, -32600, 'invalid request'), sessionId };
    }

    const params = message.params || {};

    if (message.method === 'initialize') {
      const session = touch(sessionId, params.clientInfo, 'initialize');
      return {
        sessionId: session.id,
        payload: rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'poly-vault', version: getVersion() },
          instructions:
            'Poly Vault indexes local 3D/2D asset libraries. Search, inspect, then export assets into the project folder you are working in.',
        }),
      };
    }

    if (message.method === 'ping') {
      return { payload: hasId ? rpcResult(id, {}) : null, sessionId };
    }

    if (message.method === 'notifications/initialized' || !hasId) {
      if (message.method && message.method.startsWith('notifications/')) {
        touch(sessionId);
        return { payload: null, sessionId };
      }
      return { payload: null, sessionId };
    }

    if (message.method === 'tools/list') {
      touch(sessionId);
      return {
        payload: rpcResult(id, { tools: TOOLS }),
        sessionId,
      };
    }

    if (message.method === 'tools/call') {
      const name = params.name;
      const session = touch(sessionId, null, typeof name === 'string' ? name : '');
      try {
        const payload = await callTool(name, params.arguments || {}, session);
        return { payload: rpcResult(id, toolResult(payload)), sessionId: session.id };
      } catch (err) {
        return {
          payload: rpcResult(id, {
            content: [{ type: 'text', text: String((err && err.message) || err) }],
            isError: true,
          }),
          sessionId: session.id,
        };
      }
    }

    if (message.method === 'resources/list') {
      return { payload: rpcResult(id, { resources: [] }), sessionId };
    }

    if (message.method === 'prompts/list') {
      return { payload: rpcResult(id, { prompts: [] }), sessionId };
    }

    return { payload: rpcError(id, -32601, `method not found: ${message.method}`), sessionId };
  }

  async function handleRpc(body, sessionHeader) {
    if (Array.isArray(body)) {
      const replies = [];
      let sessionId = sessionHeader;
      for (const message of body) {
        const out = await handleMessage(message, sessionId);
        sessionId = out.sessionId || sessionId;
        if (out.payload) replies.push(out.payload);
      }
      return { payload: replies.length ? replies : null, sessionId };
    }
    return handleMessage(body, sessionHeader);
  }

  function snapshot() {
    const at = now();
    const agents = Array.from(sessions.values())
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, 20)
      .map((session) => ({
        ...session,
        connected: at - session.lastSeenAt < AGENT_TTL_MS,
      }));
    return {
      agents,
      exports: exportsCache.slice(-25).reverse(),
      mcp: { url: mcpUrl, protocolVersion: PROTOCOL_VERSION, tools: TOOLS.length },
    };
  }

  return { handleRpc, closeSession, snapshot, recordExport };
}

module.exports = {
  createAgentHub,
  AgentError,
  TOOLS,
  PROTOCOL_VERSION,
  MAX_EXPORTS,
  AGENT_TTL_MS,
  isWithin,
  assertDestination,
  sanitizeSubfolder,
  resolveAsset,
  walkFiles,
  collectSources,
};
