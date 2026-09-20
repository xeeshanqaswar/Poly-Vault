'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { scanLibrary } = require('./library');

const ALLOWED_PREVIEW_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
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

/**
 * Local HTTP bridge. Serves reading the library, previews, tags, and the
 * import-job queue consumed by the Unity Editor plugin.
 *
 * getState() => { name, version, libraries: [{id,name,path}], jobs: Job[] }
 * tags      => { getAll(): { [absPath]: string[] }, set(absPath, tags): string[] }
 * meta      => { getAll(): { [absPath]: { description: string } }, set(absPath, description): string }
 * onJobsChanged(jobs) => called whenever the job queue is mutated (cheap to persist).
 */
function startBridge({ host = '127.0.0.1', port = 7100, getState, tags, meta, onJobsChanged, onDiag }) {
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
        sendJson(res, 200, {
          ok: true,
          libraries: rescanned,
          serverTime: new Date().toISOString(),
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
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': stat.size,
          'Cache-Control': 'no-store',
        });
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