use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::Regex;

const STOPWORDS: &[&str] = &[
    "of", "and", "the", "for", "with", "from", "pack", "packages", "collection", "collections",
    "bundle", "bundles", "assets", "asset", "game", "unity", "3d", "2d", "models", "model",
    "textures", "materials", "complete", "set", "sets", "vol", "volume", "v2", "v3", "pro",
    "ultimate", "hope",
];

const RULES: &[(&str, &[&str])] = &[
    ("3d", &["3d", "3 d", "voxel"]),
    ("2d", &["2d", "2 d", "flat"]),
    ("character", &["character", "characters"]),
    ("creature", &["creature", "creatures", "monster", "monsters"]),
    ("animal", &["animal", "animals"]),
    ("nature", &["nature", "natural"]),
    (
        "vegetation",
        &[
            "vegetation", "tree", "trees", "plant", "plants", "bush", "bushes", "grass",
            "flower", "flowers",
        ],
    ),
    ("environment", &["environment", "environmental"]),
    ("landscape", &["landscape", "terrain"]),
    (
        "architecture",
        &[
            "architecture", "architectural", "building", "buildings", "house", "city", "urban",
        ],
    ),
    ("interior", &["interior", "interiors"]),
    ("props", &["prop", "props"]),
    (
        "furniture",
        &["furniture", "chair", "chairs", "table", "sofa", "couch"],
    ),
    (
        "vehicle",
        &[
            "vehicle", "vehicles", "car", "cars", "truck", "trucks", "motorcycle", "bike",
            "aircraft", "helicopter", "boat", "boats", "ship", "tank",
        ],
    ),
    (
        "weapon",
        &["weapon", "weapons", "gun", "guns", "rifle", "bow", "sword", "swords", "blade"],
    ),
    (
        "sci-fi",
        &[
            "sci-fi", "scifi", "science fiction", "science-fiction", "cyberpunk", "spaceship",
            "spaceships", "futuristic", "mech",
        ],
    ),
    (
        "fantasy",
        &["fantasy", "magical", "medieval", "dragon", "dungeon", "knight", "wizard"],
    ),
    ("low-poly", &["low-poly", "low poly", "lowpoly"]),
    (
        "stylized",
        &["stylized", "stylised", "cartoon", "hand painted", "handpainted"],
    ),
    ("realistic", &["realistic", "photoreal", "photorealistic", "pbr"]),
    ("texture", &["texture", "textures", "seamless", "albedo"]),
    ("material", &["material", "materials"]),
    ("hdri", &["hdri", "hdr"]),
    ("lighting", &["lighting", "lightmap"]),
    (
        "vfx",
        &[
            "vfx", "visual effect", "visual effects", "special effect", "special effects",
            "particle", "particles", "explosion",
        ],
    ),
    ("shader", &["shader", "shaders", "shadergraph"]),
    (
        "audio",
        &[
            "audio", "sound", "sounds", "soundtrack", "sound effects", "sfx", "music", "voice",
        ],
    ),
    ("ui", &["ui", "user interface", "hud", "menu"]),
    ("icon", &["icon", "icons"]),
    ("font", &["font", "fonts", "typography", "typeface"]),
    (
        "sprite",
        &[
            "sprite", "sprites", "pixel art", "pixelart", "tile", "tiles", "tileset", "tilemap",
            "sheet",
        ],
    ),
    (
        "animation",
        &["animation", "animated", "animations", "rig", "rigged", "infinite"],
    ),
    ("game-ready", &["game-ready", "game ready", "gameplay", "ready to use"]),
    ("kitbash", &["kitbash", "kit bash", "modular"]),
    ("fps", &["fps", "first person"]),
    ("rpg", &["rpg", "role playing", "roleplaying"]),
    ("sandbox", &["sandbox", "open world"]),
    ("skeleton", &["skeleton", "skeletons"]),
    ("abstract", &["abstract"]),
    ("glitch", &["glitch"]),
];

fn compiled_rules() -> &'static Vec<(&'static str, Regex)> {
    static COMPILED: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    COMPILED.get_or_init(|| {
        RULES
            .iter()
            .map(|(tag, words)| {
                let joined = words
                    .iter()
                    .map(|w| regex::escape(w))
                    .collect::<Vec<_>>()
                    .join("|");
                let re = Regex::new(&format!("(?i)(^|\\W)({joined})(\\W|$)"))
                    .expect("auto-tag rule compiles");
                (*tag, re)
            })
            .collect()
    })
}

fn category_tag(segment: &str) -> Option<&'static str> {
    let mapped = match segment {
        "3d" => "3d",
        "2d" => "2d",
        "models" => "3d",
        "characters" => "character",
        "characters & creatures" => "character",
        "creatures" => "creature",
        "animals" | "animal" => "animal",
        "textures" | "textures & materials" => "texture",
        "materials" => "material",
        "props" => "props",
        "environments" | "environment" => "environment",
        "nature" => "nature",
        "vegetation" => "vegetation",
        "architecture" => "architecture",
        "vehicles" => "vehicle",
        "science fiction" | "sci-fi" => "sci-fi",
        "fantasy" => "fantasy",
        "low-poly" => "low-poly",
        "stylized" => "stylized",
        "vfx" => "vfx",
        "particle effects" => "vfx",
        "shaders" => "shader",
        "audio" | "sound effects" | "music" => "audio",
        "fonts" => "font",
        "ui" | "user interface" => "ui",
        "sprites" => "sprite",
        "tilemaps" => "sprite",
        "tiles & worlds" => "sprite",
        "icons" => "icon",
        "weapons" | "weapon" => "weapon",
        "furniture" => "furniture",
        "pbr" => "realistic",
        "" => "",
        "templates" | "tools" | "game templates" | "source code" | "unity tools"
        | "essentials" | "perfops" => "",
        _ => return None,
    };
    Some(mapped)
}

fn normalize(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .replace('&', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('-', " ")
}

fn tags_from_category(category: &str) -> Vec<String> {
    let mut tags = BTreeSet::new();
    if category.is_empty() {
        return Vec::new();
    }
    for raw in category.split(['>', '/']) {
        let segment = normalize(raw);
        if segment.is_empty() || STOPWORDS.contains(&segment.as_str()) {
            continue;
        }
        match category_tag(&segment) {
            Some(mapped) if !mapped.is_empty() => {
                tags.insert(mapped.to_string());
            }
            _ => {
                if segment.len() > 2 {
                    tags.insert(segment);
                }
            }
        }
    }
    tags.into_iter().collect()
}

/// Derives a sorted, unique, lowercase tag set from a store product name,
/// category path, and description — mirrors `deriveTags` in autoTags.js.
pub fn derive_tags(name: &str, category: &str, description: &str) -> Vec<String> {
    let mut tags = BTreeSet::new();
    let haystack = format!("{name} {description}").to_lowercase();

    for (tag, re) in compiled_rules() {
        if re.is_match(&haystack) {
            tags.insert((*tag).to_string());
        }
    }
    for tag in tags_from_category(category) {
        tags.insert(tag);
    }
    tags.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_tags_from_description_and_category() {
        assert_eq!(
            derive_tags(
                "Chair",
                "3D > Furniture",
                "A low poly wooden chair with a fabric seat."
            ),
            vec!["furniture", "low-poly"]
        );
    }

    #[test]
    fn ignores_unmapped_category_noise() {
        assert_eq!(derive_tags("Chair", "3D > Furniture", ""), vec!["furniture"]);
        assert_eq!(
            derive_tags("Template", "Templates > Tools", ""),
            vec!["templates", "tools"]
        );
    }
}
