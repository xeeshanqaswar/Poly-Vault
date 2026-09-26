'use strict';

// Derives a sensible, lowercase tag set for an asset from the text the Unity
// Asset Store returned (description + product name) and the store's own
// category path. Used by the main-process enrichment engine so a newly-added
// asset is auto-tagged from its fetched description.

const STOPWORDS = new Set([
  'of', 'and', 'the', 'for', 'with', 'from', 'pack', 'packages', 'collection',
  'collections', 'bundle', 'bundles', 'assets', 'asset', 'game', 'unity',
  '3d', '2d', 'models', 'model', 'textures', 'materials', 'complete', 'set',
  'sets', 'vol', 'volume', 'v2', 'v3', 'pro', 'ultimate', 'hope',
]);

// Single shared builder per tag so synonyms collapse onto one spelling.
const RULES = [
  { tag: '3d', words: ['3d', '3 d', 'voxel'] },
  { tag: '2d', words: ['2d', '2 d', 'flat'] },
  { tag: 'character', words: ['character', 'characters'] },
  { tag: 'creature', words: ['creature', 'creatures', 'monster', 'monsters'] },
  { tag: 'animal', words: ['animal', 'animals'] },
  { tag: 'nature', words: ['nature', 'natural'] },
  { tag: 'vegetation', words: ['vegetation', 'tree', 'trees', 'plant', 'plants', 'bush', 'bushes', 'grass', 'flower', 'flowers'] },
  { tag: 'environment', words: ['environment', 'environmental'] },
  { tag: 'landscape', words: ['landscape', 'terrain'] },
  { tag: 'architecture', words: ['architecture', 'architectural', 'building', 'buildings', 'house', 'city', 'urban'] },
  { tag: 'interior', words: ['interior', 'interiors'] },
  { tag: 'props', words: ['prop', 'props'] },
  { tag: 'furniture', words: ['furniture', 'chair', 'chairs', 'table', 'sofa', 'couch'] },
  { tag: 'vehicle', words: ['vehicle', 'vehicles', 'car', 'cars', 'truck', 'trucks', 'motorcycle', 'bike', 'aircraft', 'helicopter', 'boat', 'boats', 'ship', 'tank'] },
  { tag: 'weapon', words: ['weapon', 'weapons', 'gun', 'guns', 'rifle', 'bow', 'sword', 'swords', 'blade'] },
  { tag: 'sci-fi', words: ['sci-fi', 'scifi', 'science fiction', 'science-fiction', 'cyberpunk', 'spaceship', 'spaceships', 'futuristic', 'mech'] },
  { tag: 'fantasy', words: ['fantasy', 'magical', 'medieval', 'dragon', 'dungeon', 'knight', 'wizard'] },
  { tag: 'low-poly', words: ['low-poly', 'low poly', 'lowpoly'] },
  { tag: 'stylized', words: ['stylized', 'stylised', 'cartoon', 'hand painted', 'handpainted'] },
  { tag: 'realistic', words: ['realistic', 'photoreal', 'photorealistic', 'pbr'] },
  { tag: 'texture', words: ['texture', 'textures', 'seamless', 'albedo'] },
  { tag: 'material', words: ['material', 'materials'] },
  { tag: 'hdri', words: ['hdri', 'hdr'] },
  { tag: 'lighting', words: ['lighting', 'lightmap'] },
  { tag: 'vfx', words: ['vfx', 'visual effect', 'visual effects', 'special effect', 'special effects', 'particle', 'particles', 'explosion'] },
  { tag: 'shader', words: ['shader', 'shaders', 'shadergraph'] },
  { tag: 'audio', words: ['audio', 'sound', 'sounds', 'soundtrack', 'sound effects', 'sfx', 'music', 'voice'] },
  { tag: 'ui', words: ['ui', 'user interface', 'hud', 'menu'] },
  { tag: 'icon', words: ['icon', 'icons'] },
  { tag: 'font', words: ['font', 'fonts', 'typography', 'typeface'] },
  { tag: 'sprite', words: ['sprite', 'sprites', 'pixel art', 'pixelart', 'tile', 'tiles', 'tileset', 'tilemap', 'sheet'] },
  { tag: 'animation', words: ['animation', 'animated', 'animations', 'rig', 'rigged', 'infinite'] },
  { tag: 'game-ready', words: ['game-ready', 'game ready', 'gameplay', 'ready to use'] },
  { tag: 'kitbash', words: ['kitbash', 'kit bash', 'modular'] },
  { tag: 'fps', words: ['fps', 'first person'] },
  { tag: 'rpg', words: ['rpg', 'role playing', 'roleplaying'] },
  { tag: 'sandbox', words: ['sandbox', 'open world'] },
  { tag: 'skeleton', words: ['skeleton', 'skeletons'] },
  { tag: 'abstract', words: ['abstract'] },
  { tag: 'glitch', words: ['glitch'] },
];

const COMPILED = RULES.map((r) => ({
  tag: r.tag,
  re: new RegExp(`(^|\\W)(${r.words
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})(\\W|$)`, 'i'),
}));

// Map the store's category segments onto canonical tags (fall back to using
// the segment itself when it is a meaningful word).
const CATEGORY_MAP = {
  '3d': '3d',
  '2d': '2d',
  'models': '3d',
  'characters': 'character',
  'characters & creatures': 'character',
  'creatures': 'creature',
  'animals': 'animal',
  'animal': 'animal',
  'textures': 'texture',
  'textures & materials': 'texture',
  'materials': 'material',
  'props': 'props',
  'environments': 'environment',
  'environment': 'environment',
  'nature': 'nature',
  'vegetation': 'vegetation',
  'architecture': 'architecture',
  'vehicles': 'vehicle',
  'science fiction': 'sci-fi',
  'sci-fi': 'sci-fi',
  'fantasy': 'fantasy',
  'low-poly': 'low-poly',
  'stylized': 'stylized',
  'vfx': 'vfx',
  'particle effects': 'vfx',
  'shaders': 'shader',
  'audio': 'audio',
  'sound effects': 'audio',
  'music': 'audio',
  'fonts': 'font',
  'ui': 'ui',
  'user interface': 'ui',
  'sprites': 'sprite',
  'tilemaps': 'sprite',
  'tiles & worlds': 'sprite',
  'icons': 'icon',
  'weapons': 'weapon',
  'weapon': 'weapon',
  'furniture': 'furniture',
  'templates': '',
  'tools': '',
  'game templates': '',
  'source code': '',
  'unity tools': '',
  'essentials': '',
  'pbr': 'realistic',
  'perfops': '',
};

function norm(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/-/g, ' ');
}

function tagsFromCategory(category) {
  const tags = new Set();
  if (!category) return [];
  for (const raw of String(category).split(/[>\/]/)) {
    const segment = norm(raw);
    if (!segment || STOPWORDS.has(segment)) continue;
    const mapped = CATEGORY_MAP[segment];
    if (mapped) {
      tags.add(mapped);
    } else if (segment.length > 2) {
      tags.add(segment);
    }
  }
  return Array.from(tags);
}

/**
 * @param {string} name         product/asset name (falls back to words only)
 * @param {string} category     store category path, e.g. "3D > Vehicles"
 * @param {string} description  flattened store description text
 * @returns {string[]} sorted, unique, lowercase tags
 */
function deriveTags(name, category, description) {
  const tags = new Set();
  const haystack = `${name || ''} ${description || ''}`.toLowerCase();

  for (const rule of COMPILED) {
    if (rule.re.test(haystack)) tags.add(rule.tag);
  }

  for (const t of tagsFromCategory(category)) {
    if (t) tags.add(t);
  }

  return Array.from(tags).sort();
}

module.exports = { deriveTags };