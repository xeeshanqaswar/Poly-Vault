'use strict';

const { deriveTags } = require('./autoTags');

const WORKERS = 3;        // parallel store lookups
const MIN_GAP_MS = 150;   // politeness gap between two lookups
const MAX_TAGS = 64;      // matches the bridge's per-path tag cap

/**
 * Throttled, deduplicated description/tag enrichment.
 *
 * Lives in the MAIN process so fetching keeps working while the window is
 * busy or closed. Everything it needs is injected, which also makes the whole
 * flow testable with a fake `lookup` (see tests/smoke.js).
 *
 * @param {object} deps
 * @param {(absPath:string)=>object|null} deps.getMeta
 * @param {(absPath:string, entry:object)=>object} deps.setMeta
 * @param {(absPath:string)=>string[]} deps.getTags
 * @param {(entries:{path:string,tags:string[]}[])=>void} deps.setTags
 * @param {(name:string)=>Promise<object>} deps.lookup  store lookup
 */
function createEnrichment({ getMeta, setMeta, getTags, setTags, lookup }) {
  const state = {
    mode: 'idle', // 'idle' | 'fetching'
    draining: false,
    queue: [],    // [{ path, name }]
    active: new Set(),
    done: 0,
    message: '',
  };

  const updateMessage = () => {
    const total = state.done + state.active.size + state.queue.length;
    state.message = state.active.size || state.queue.length
      ? `Fetching descriptions… ${state.done + state.active.size}/${total}`
      : '';
  };

  // One lane keeps pulling from the shared queue until it is empty, so the
  // queue can be refilled at any time without tracking a worker count.
  async function lane() {
    while (state.queue.length) {
      const item = state.queue.shift();
      if (state.active.has(item.path)) continue;
      state.active.add(item.path);
      updateMessage();
      const started = Date.now();
      try {
        const res = await lookup(item.name);
        if (res && res.found) {
          const derived = deriveTags(item.name, res.category, res.description);
          if (derived.length) {
            const merged = Array.from(new Set([...(getTags(item.path) || []), ...derived]))
              .sort()
              .slice(0, MAX_TAGS);
            setTags([{ path: item.path, tags: merged }]);
          }
        }
        setMeta(item.path, {
          description: (res && res.description) || '',
          name: (res && res.name) || '',
          url: (res && res.url) || '',
          found: !!(res && res.found),
        });
      } catch (_) {
        setMeta(item.path, { found: false });
      } finally {
        state.active.delete(item.path);
        state.done += 1;
        updateMessage();
      }
      const elapsed = Date.now() - started;
      if (elapsed < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - elapsed));
    }
  }

  async function drain() {
    try {
      await Promise.all(Array.from({ length: WORKERS }, () => lane()));
      state.mode = 'idle';
      state.done = 0;
      state.message = '';
    } finally {
      state.draining = false;
      // Anything queued while we were finishing gets a fresh pass.
      if (state.queue.length) start();
    }
  }

  function start() {
    if (state.draining) return;
    state.draining = true;
    state.mode = 'fetching';
    state.done = 0;
    drain();
  }

  /**
   * Queues assets for enrichment.
   * @param {{path:string,name:string}[]} items
   * @param {{force?:boolean}} [opts] force re-checks assets whose earlier
   *   lookup found nothing (used by the Update action).
   * @returns {number} how many items were queued
   */
  function request(items, opts) {
    if (!Array.isArray(items) || !items.length) return 0;
    const force = !!(opts && opts.force);
    const seen = new Set(state.active);
    const queued = new Set(state.queue.map((q) => q.path));
    let added = 0;
    for (const it of items) {
      if (!it || !it.path) continue;
      const entry = getMeta(it.path);
      if (entry && entry.fetchedAt && !(force && !entry.found)) continue;
      if (seen.has(it.path) || queued.has(it.path)) continue;
      state.queue.push({ path: it.path, name: it.name || it.path });
      queued.add(it.path);
      added += 1;
    }
    if (!added) return 0;
    updateMessage();
    start();
    return added;
  }

  const status = () => ({
    state: state.mode,
    pending: state.queue.length,
    active: state.active.size,
    done: state.done,
    message: state.message,
  });

  return { request, status };
}

/**
 * Folds a lookup result into the stored metadata record.
 *
 * A lookup that found nothing must never wipe a description the user typed by
 * hand, so only a real fetched description replaces the previous text. Clearing
 * a description stays possible through the manual PUT /api/meta endpoint.
 */
function mergeMetaEntry(prev, entry, fetchedAt) {
  const p = prev || {};
  const e = entry || {};
  return {
    description:
      typeof e.description === 'string' && e.description ? e.description : p.description || '',
    name: e.name || p.name || '',
    url: e.url || p.url || '',
    found: e.found === undefined ? !!p.found : !!e.found,
    fetchedAt: e.fetchedAt || p.fetchedAt || fetchedAt || new Date().toISOString(),
  };
}

module.exports = { createEnrichment, mergeMetaEntry, WORKERS, MIN_GAP_MS, MAX_TAGS };