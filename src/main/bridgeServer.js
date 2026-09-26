'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { scanLibrary } = require('./library');

const ALLOWED_PREVIEW_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const PREVIEW_CACHE_CONTROL = 'private, max-age=3600';
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const JOB_STATES = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  DONE: 'done',
  FAILED: 'failed',
});
const TERMINAL_STATES = new Set([JOB_STATES.DONE, JOB_STATES.FAILED]);

function createJob(asset, now = new Date()) {
  return {
    id: crypto.randomUUID(),
    assetId: asset.id,
    assetName: asset.name,
    category: asset.category,
    libraryName: asset.libraryName,
    assetFolder: asset.folder,
    tags: Array.isArray(asset.tags) ? asset.tags.slice() : [],
    importables: (asset.importables || []).map((i) => ({
      name: i.name,
      path: i.path,
      rel: i.rel,
      kind: i.kind,
    })),
    status: JOB_STATES.PENDING,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    note: '',
  };
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function withinLibrary(pathToCheck, libraries) {
  const resolved = path.resolve(pathToCheck);
  return libraries.some((lib) => {
    const root = path.resolve(lib.path);
    return resolved === root || resolved.startsWith(root + path.sep);
  });
}

function normalizeTagList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const t of value) {
    const s = String(t).trim().toLowerCase();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function sanitizeScope(raw) {
  const types = ['all', 'library', 'container', 'asset'];
  const scope = { type: raw && types.includes(raw.type) ? raw.type : 'all' };
  if (raw && raw.libId) scope.libId = String(raw.libId);
  if (raw && raw.rel) scope.rel = String(raw.rel);
  return scope;
}

/**
 * Local HTTP bridge. Serves reading the library, previews, tags, and the
 * import-job queue consumed by the Unity Editor plugin.
 *
 * getState() => { name, version, libraries: [{id,name,path}], jobs: Job[] }
 * tags      => { getAll(): { [absPath]: string[] }, set(absPath, tags): string[] }
 * meta      => { getAll(): { [absPath]: { description: string } }, set(absPath, description): string }
 * enrichment=> { request([{path,name}]): number, status(): {state,pending,active,done,message} }
 * update    => { run(scope): Promise<{libraries, targets:[{path,name}]}> }
 * onJobsChanged(jobs) => called whenever the job queue is mutated (cheap to persist).
 */
function startBridge({ host = '127.0.0.1', port = 7100, getState, tags, meta, onJobsChanged, onDiag, enrichment, update }) {
  let lastUnitySeen = 0; // epoch ms of the last /api/unity/* request (Unity plugin poll)
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${host}:${port}`);
    const route = url.pathname.replace(/\/+$/, '') || '/';

    try {
      const state = getState();
      const libs = state.libraries || [];

      if (req.method === 'GET' && route === '/api/status') {
        sendJson(res, 200, {
          ok: true,
          name: state.name,
          version: state.version,
          time: new Date().toISOString(),
          libraryCount: libs.length,
          libraries: libs.map((l) => ({ id: l.id, name: l.name, path: l.path })),
          unitySeenAt: lastUnitySeen,
        });
        return;
      }

      if (req.method === 'GET' && route === '/api/library') {
        const tagMap = tags && tags.getAll ? tags.getAll() : {};
        const metaMap = meta && meta.getAll ? meta.getAll() : {};
        const getTagsFor = (absPath) => {
          const key = path.resolve(absPath);
          const list = tagMap[key];
          return Array.isArray(list) ? list : [];
        };
        const getMetaFor = (absPath) => {
          const key = path.resolve(absPath);
          const entry = metaMap[key];
          return entry && entry.description ? entry.description : '';
        };
        const rescanned = libs.map((lib) => scanLibrary(lib, { getTags: getTagsFor, getMeta: getMetaFor }));
        if (enrichment && enrichment.request) {
          const fresh = [];
          for (const lib of rescanned) {
            for (const a of lib.assets || []) fresh.push({ path: a.folder, name: a.name });
          }
          if (fresh.length) enrichment.request(fresh);
        }
        sendJson(res, 200, {
          ok: true,
          libraries: rescanned,
          serverTime: new Date().toISOString(),
        });
        return;
      }

      if (req.method === 'GET' && route === '/api/enrichment') {
        const status = enrichment && enrichment.status ? enrichment.status() : { state: 'idle', pending: 0, active: 0, done: 0, message: '' };
        sendJson(res, 200, { ok: true, status });
        return;
      }

      if (req.method === 'POST' && route === '/api/update') {
        const body = await readBody(req);
        const scope = sanitizeScope(body && body.scope);
        if (!update || typeof update.run !== 'function') {
          sendJson(res, 400, { ok: false, error: 'update not wired' });
          return;
        }
        const result = await update.run(scope);
        if (enrichment && enrichment.request && Array.isArray(result.targets)) {
          enrichment.request(result.targets, { force: true });
        }
        sendJson(res, 200, {
          ok: true,
          libraries: result.libraries,
          targets: result.targets,
          status: enrichment && enrichment.status ? enrichment.status() : null,
        });
        return;
      }

      if (req.method === 'GET' && route === '/api/meta') {
        const metaMap = meta && meta.getAll ? meta.getAll() : {};
        sendJson(res, 200, { ok: true, meta: metaMap });
        return;
      }

      if (req.method === 'PUT' && route === '/api/meta') {
        const body = await readBody(req);
        const target = body && body.path;
        if (!target || !meta || !meta.set) {
          sendJson(res, 400, { ok: false, error: 'missing path' });
          return;
        }
        if (!withinLibrary(target, libs)) {
          sendJson(res, 403, { ok: false, error: 'path outside libraries' });
          return;
        }
        const description = body.description == null ? '' : String(body.description).trim();
        const saved = meta.set(target, description);
        sendJson(res, 200, { ok: true, path: target, description: saved });
        return;
      }

      if (req.method === 'GET' && route === '/api/tags') {
        const tagMap = tags && tags.getAll ? tags.getAll() : {};
        sendJson(res, 200, { ok: true, tags: tagMap });
        return;
      }

      if (req.method === 'PUT' && route === '/api/tags') {
        const body = await readBody(req);
        const target = body && body.path;
        if (!target || !tags || !tags.set) {
          sendJson(res, 400, { ok: false, error: 'missing path' });
          return;
        }
        if (!withinLibrary(target, libs)) {
          sendJson(res, 403, { ok: false, error: 'path outside libraries' });
          return;
        }
        const raw = Array.isArray(body.tags)
          ? body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
          : [];
        const seen = new Set();
        const list = [];
        for (const t of raw) {
          if (!seen.has(t)) {
            seen.add(t);
            list.push(t);
          }
        }
        const saved = tags.set(target, list.slice(0, 64));
        sendJson(res, 200, { ok: true, path: target, tags: saved });
        return;
      }

      if (req.method === 'POST' && route === '/api/tags/apply') {
        const body = await readBody(req);
        const paths = (Array.isArray(body.paths) ? body.paths : []).map((p) => String(p)).filter(Boolean);
        if (!paths.length || !tags || !tags.applyBulk) {
          sendJson(res, 400, { ok: false, error: 'missing paths' });
          return;
        }
        for (const p of paths) {
          if (!withinLibrary(p, libs)) {
            sendJson(res, 403, { ok: false, error: 'path outside libraries' });
            return;
          }
        }
        const add = normalizeTagList(body.add);
        const remove = new Set(normalizeTagList(body.remove));
        const all = tags.getAll ? tags.getAll() : {};
        const entries = [];
        for (const p of paths) {
          const current = all[path.resolve(p)];
          const base = Array.isArray(current) ? current : [];
          const list = [];
          const seen = new Set();
          for (const t of base) {
            if (!remove.has(t) && !seen.has(t)) {
              seen.add(t);
              list.push(t);
            }
          }
          for (const t of add) {
            if (!seen.has(t)) {
              seen.add(t);
              list.push(t);
            }
          }
          entries.push({ path: p, tags: list.slice(0, 64) });
        }
        const count = tags.applyBulk(entries);
        sendJson(res, 200, { ok: true, count });
        return;
      }

      if (req.method === 'GET' && route === '/api/preview') {
        const target = url.searchParams.get('path');
        if (!target) {
          sendJson(res, 400, { ok: false, error: 'missing path' });
          return;
        }
        const ext = path.extname(target).toLowerCase();
        if (!ALLOWED_PREVIEW_EXT.has(ext)) {
          sendJson(res, 400, { ok: false, error: 'forbidden extension' });
          return;
        }
        if (!withinLibrary(target, libs)) {
          sendJson(res, 403, { ok: false, error: 'path outside libraries' });
          return;
        }
        let stat;
        try {
          stat = fs.statSync(target);
        } catch (_) {
          sendJson(res, 404, { ok: false, error: 'not found' });
          return;
        }
        const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
        const base = {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': PREVIEW_CACHE_CONTROL,
          ETag: etag,
          'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
        };
        const inm = req.headers['if-none-match'];
        const ims = req.headers['if-modified-since'];
        const fresh = (inm && inm.split(',').some((t) => t.trim() === etag))
          || (!inm && ims && Date.parse(ims) >= Math.trunc(stat.mtimeMs / 1000) * 1000);
        if (fresh) {
          res.writeHead(304, base);
          res.end();
          return;
        }
        res.writeHead(200, { ...base, 'Content-Length': stat.size });
        fs.createReadStream(target).pipe(res);
        return;
      }

      if (req.method === 'POST' && route === '/api/import-job') {
        const body = await readBody(req);
        const folder = body && body.assetFolder;
        if (!folder) {
          sendJson(res, 400, { ok: false, error: 'missing assetFolder' });
          return;
        }
        if (!body.importables || !Array.isArray(body.importables) || body.importables.length === 0) {
          sendJson(res, 400, { ok: false, error: 'asset has nothing importable' });
          return;
        }
        if (!withinLibrary(folder, libs)) {
          sendJson(res, 403, { ok: false, error: 'asset outside libraries' });
          return;
        }
        const job = createJob({
          id: body.assetId,
          name: body.assetName,
          category: body.category,
          libraryName: body.libraryName,
          folder,
          tags: body.tags,
          importables: body.importables,
        });
        state.jobs.push(job);
        if (onJobsChanged) onJobsChanged(state.jobs);
        sendJson(res, 201, { ok: true, job });
        return;
      }

      if (req.method === 'GET' && route === '/api/import-jobs') {
        sendJson(res, 200, { ok: true, jobs: state.jobs });
        return;
      }

      if (req.method === 'GET' && route === '/api/unity/import-jobs') {
        lastUnitySeen = Date.now();
        const active = state.jobs.filter((j) => !TERMINAL_STATES.has(j.status));
        sendJson(res, 200, { ok: true, jobs: active });
        return;
      }

      if (req.method === 'GET' && route === '/__diag') {
        const action = url.searchParams.get('action') || '';
        const diag = onDiag ? await onDiag(action) : { error: 'not wired' };
        sendJson(res, 200, { ok: true, ...diag });
        return;
      }

      const jobStatusMatch = route.match(/^\/api\/unity\/import-jobs\/([^/]+)\/(complete|failed)$/);
      if (req.method === 'POST' && jobStatusMatch) {
        lastUnitySeen = Date.now();
        const [, jobId, action] = jobStatusMatch;
        const body = await readBody(req);
        const job = state.jobs.find((j) => j.id === jobId);
        if (!job) {
          sendJson(res, 404, { ok: false, error: 'job not found' });
          return;
        }
        job.status = action === 'complete' ? JOB_STATES.DONE : JOB_STATES.FAILED;
        job.note = body.note || '';
        job.updatedAt = new Date().toISOString();
        if (onJobsChanged) onJobsChanged(state.jobs);
        sendJson(res, 200, { ok: true, job });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found', route });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
  });

  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server));
    });

  return { server, listen, host, port };
}

module.exports = { startBridge, JOB_STATES, TERMINAL_STATES, createJob };