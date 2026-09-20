'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tiny JSON-backed key/value store. Pure Node (no Electron APIs) so it can be
 * unit-tested and also used by the standalone bridge server.
 */
class JsonStore {
  /**
   * @param {string} filePath   Path to the JSON file backing this store.
   * @param {object} seed       Default data used when the file does not exist.
   */
  constructor(filePath, seed = {}) {
    this.filePath = filePath;
    this.seed = seed;
    this.data = null;
    this.load();
  }

  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        const bak = `${this.filePath}.corrupt-${Date.now()}`;
        try { fs.renameSync(this.filePath, bak); } catch (_) { /* ignore */ }
      }
      this.data = JSON.parse(JSON.stringify(this.seed));
      this.save();
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return value;
  }

  update(fn) {
    const result = fn(this.data);
    this.save();
    return result;
  }
}

module.exports = { JsonStore };