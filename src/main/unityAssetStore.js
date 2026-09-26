'use strict';

// UnityEngine Asset Store lookups done from the MAIN process (the renderer's
// CSP only allows loopback connections). Two official stores are used:
//
//  1. /sitemap?q=<name>          server-rendered SOLR search results
//                                ("searchPackageFromSolr"), returning the
//                                product id/name/category without any login.
//  2. /packages/<cat>/<slug>-<id> server-rendered product page whose app-state
//                                JSON embeds the full "description" (HTML).

const https = require('https');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const BASE = 'https://assetstore.unity.com';
const MAX_DESC = 12000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20000;

function fetchBody(url, accept) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': UA,
        Accept: accept || 'text/html,application/json',
        'Accept-Language': 'en',
        Referer: BASE + '/',
      },
    }, (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ status, redirect: new URL(res.headers.location, url).toString() });
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let body = buf.toString('utf8');
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        if ((enc.includes('gzip') || enc.includes('deflate')) && buf.length > 2) {
          try {
            const zlib = require('zlib');
            body = zlib.gunzipSync(buf).toString('utf8');
          } catch (_) { /* keep as-is */ }
        }
        resolve({ status, body });
      });
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('request timed out')));
  });
}

async function fetchWithRedirects(startUrl) {
  let url = startUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetchBody(url);
    if (res.status >= 300 && res.status < 400 && res.redirect) {
      url = res.redirect;
      continue;
    }
    return res;
  }
  return { status: 599, body: '' };
}

// Pull the value of a JSON array that lives inside "searchPackageFromSolr" on
// the /sitemap page (which embeds unescaped app-state JSON).
function extractJsonArray(text, marker) {
  const rel = text.indexOf(marker);
  if (rel < 0) return null;
  const resIdx = text.indexOf('"results":', rel);
  if (resIdx < 0) return null;
  return parseArrayContent(text, resIdx + '"results":'.length);
}

// Walk to the array that opens right after the given offset, respecting string
// escapes so embedded braces/quotes inside values don't confuse the depth.
function parseArrayContent(text, i) {
  let j = i;
  while (j < text.length && text[j] !== '[') j += 1;
  if (j >= text.length) return null;
  let depth = 0;
  let inString = false;
  let k = j;
  for (; k < text.length; k++) {
    const ch = text[k];
    if (inString) {
      if (ch === '\\') k += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  try {
    return JSON.parse(text.slice(j, k + 1));
  } catch (_) {
    return null;
  }
}

function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function tokenize(name) {
  return normalize(name);
}

// Pick the store product that best matches the user's folder name.
// Store names tile every highlighting word (e.g. "POLYGON - Sci-Fi
// City Pack - Art by Synty"), so length ratios matter.
function pickBest(query, results) {
  const qw = tokenize(query);
  const qset = new Set(qw);
  let best = null;
  let bestScore = 0;
  for (const r of results) {
    const rw = tokenize(r.name || '');
    if (rw.join(' ') === qw.join(' ')) {
      best = r;
      bestScore = 1;
      break;
    }
    const rset = new Set(rw);
    let common = 0;
    for (const w of rset) if (qset.has(w)) common += 1;
    let score = 0;
    if (qw.length === 1 && common === 1 && qw[0].length >= 3) {
      // single-token folders: prefer the shortest matching store name so
      // "space" resolves to a pack titled just "Space" rather than a giant one
      score = 1 / Math.max(1, rw.length);
    } else if (common === qw.length && rw.length >= qw.length) {
      // full containment: the store name includes every query token
      score = 0.5 + qw.length / Math.max(1, rw.length);
    } else if (common >= Math.max(2, Math.floor(qw.length * 0.75))) {
      // partial overlap: enough tokens to trust the tie
      score = common / Math.max(qw.length, rw.length);
    }
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  if (!best || bestScore <= 0) return { found: false };
  return { found: true, score: bestScore, product: best };
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function safeCodePoint(code) {
  try { return String.fromCodePoint(code); } catch (_) { return ''; }
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|h[1-6])>/gi, '\n\n')
    .replace(/<\/(?:li|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\u2022 ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td><\/td>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt('0x' + h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_DESC);
}

// The product description lives in the page's embedded app-state inside the
// dedicated product object:
//   "<id>":{"id":"<id>","productId":...,"name":"...","description":"<HTML>"}
// Anchor on that object and read the FIRST description value that follows it.
// (Other "description" strings on the page belong to recommended products.)
function extractDescription(pageHtml, productId) {
  const anchor = new RegExp('"' + productId + '":\\{"id":"' + productId + '",');
  const a = anchor.exec(pageHtml);
  if (!a) return '';
  let i = a.index + a[0].length;
  const windowEnd = Math.min(pageHtml.length, i + 20000);
  const keyStart = pageHtml.indexOf('"description":"', i);
  if (keyStart < 0 || keyStart > windowEnd) return '';
  i = keyStart + '"description":"'.length;
  let k = i;
  while (k < pageHtml.length && k < windowEnd) {
    const ch = pageHtml[k];
    if (ch === '\\') k += 2;
    else if (ch === '"') break;
    else k += 1;
  }
  if (k >= pageHtml.length || k >= windowEnd) return '';
  try {
    const html = JSON.parse('"' + pageHtml.slice(i, k) + '"');
    return htmlToText(html);
  } catch (_) {
    return '';
  }
}

// Public entry point: name -> best matching product + description.
async function findAndFetchDescription(query) {
  const q = String(query || '').trim();
  if (!q || q.length > 200) {
    return { found: false, error: 'invalid query' };
  }
  try {
    const searchUrl = `${BASE}/sitemap?q=${encodeURIComponent(q)}`;
    const res = await fetchWithRedirects(searchUrl);
    if (res.status !== 200) {
      return { found: false, error: `store search unavailable (http ${res.status})` };
    }
    const results = extractJsonArray(res.body, 'searchPackageFromSolr');
    const products = (results || []).filter((r) => r && r.id && r.name);
    if (!products.length) {
      return { found: false, nonexistent: true, error: 'no product found' };
    }
    const hot = pickBest(q, products);
    if (!hot.found) {
      return { found: false, nonexistent: true, error: 'no matching product' };
    }
    const product = hot.product;
    const category = String(product.category || '');
    const slug = slugify(product.name);
    const pageUrl = `${BASE}/packages/${category}/${slug}-${product.id}`;
    const page = await fetchWithRedirects(pageUrl);
    if (page.status !== 200) {
      return {
        found: true,
        id: product.id,
        name: product.name,
        url: pageUrl,
        description: '',
        error: `product page returned http ${page.status}`,
      };
    }
    const description = extractDescription(page.body, String(product.id));
    return {
      found: true,
      id: product.id,
      name: product.name,
      url: pageUrl,
      category,
      description,
    };
  } catch (err) {
    return { found: false, error: String((err && err.message) || err) };
  }
}

module.exports = { findAndFetchDescription };