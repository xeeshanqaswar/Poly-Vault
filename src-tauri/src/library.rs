use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::paths::{compare_names, hash_string, rel_path};
use crate::store::system_time_iso;
use crate::time::now_iso;

pub const PREVIEW_PRIORITY: [&str; 4] = [".png", ".jpg", ".jpeg", ".webp"];

pub const IMPORTABLE_EXTENSIONS: &[&str] = &[
    ".unitypackage", ".prefab", ".scene", ".fbx", ".obj", ".glb", ".gltf", ".blend", ".dae",
    ".3ds", ".dxf", ".stl", ".max", ".c4d", ".mb", ".ma", ".abc", ".x", ".lwo", ".lws", ".ply",
    ".png", ".jpg", ".jpeg", ".tga", ".psd", ".tif", ".tiff", ".bmp", ".gif", ".exr", ".hdr",
    ".dds", ".ktx", ".pvr", ".ttf", ".otf", ".dfont", ".wav", ".mp3", ".ogg", ".aif", ".aiff",
    ".flac", ".xm", ".mod", ".it", ".s3m", ".mp4", ".mov", ".avi", ".webm", ".m4v", ".mpg",
    ".mpeg", ".asf", ".wmv", ".bvh", ".htr", ".anim", ".controller", ".overridecontroller",
    ".mat", ".spriteatlas", ".mask", ".cs", ".dll", ".asmdef", ".asmref", ".shader", ".cginc",
    ".hlsl", ".mixer", ".playable", ".rendertexture", ".flare", ".halo", ".lighting",
];

pub const MESH_EXTENSIONS: &[&str] = &[
    ".fbx", ".obj", ".glb", ".gltf", ".blend", ".dae", ".3ds", ".dxf", ".stl", ".max", ".c4d",
    ".mb", ".ma", ".abc", ".x", ".lwo", ".lws", ".ply",
];

pub const IMAGE_EXTENSIONS: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".tga", ".psd", ".tif", ".tiff", ".bmp", ".exr",
    ".hdr", ".svg",
];

pub const AUDIO_EXTENSIONS: &[&str] = &[
    ".wav", ".mp3", ".ogg", ".aif", ".aiff", ".flac", ".xm", ".mod", ".it", ".s3m",
];

pub const VIDEO_EXTENSIONS: &[&str] = &[
    ".mp4", ".mov", ".avi", ".webm", ".m4v", ".mpg", ".mpeg", ".asf", ".wmv",
];

const FONT_EXTENSIONS: &[&str] = &[".ttf", ".otf", ".dfont"];

const SCRIPT_EXTENSIONS: &[&str] = &[".cs", ".dll", ".asmdef", ".asmref", ".shader", ".cginc", ".hlsl"];

const MATERIAL_EXTENSIONS: &[&str] = &[".mat", ".mtl", ".physicmaterial", ".physicsmaterial"];

const IGNORED_DIR_NAMES: &[&str] = &[
    ".git", ".svn", ".hg", ".ds_store", "node_modules", "__pycache__", "thumbs",
    "thumbnails", "previews", "temp", "tmp",
];

const IGNORE_MARKERS: &[&str] = &[".nomedia", ".assetvault-ignore"];

const MAX_SCAN_DEPTH: usize = 12;
const MAX_SCAN_FILES: usize = 4000;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Importable {
    pub name: String,
    pub path: String,
    pub rel: String,
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRef {
    pub path: String,
    pub rel: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub rel_path: String,
    pub category: String,
    pub library_id: String,
    pub library_name: String,
    pub folder: String,
    pub size_bytes: u64,
    pub file_count: usize,
    pub kind_counts: BTreeMap<String, u32>,
    pub preview: Option<PreviewRef>,
    pub importables: Vec<Importable>,
    pub importable: bool,
    pub kinds: Vec<String>,
    pub kind: String,
    pub tags: Vec<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
    pub description: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    #[serde(rename = "type")]
    pub node_type: String,
    pub name: String,
    pub path: String,
    pub rel: String,
    pub count: u32,
    pub asset_count: u32,
    pub file_count: usize,
    pub size_bytes: u64,
    pub kind_counts: BTreeMap<String, u32>,
    pub tags: Vec<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
    pub description: String,
    pub children: Vec<TreeNode>,
    pub asset: Option<Asset>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScan {
    pub id: String,
    pub name: String,
    pub path: String,
    pub total_assets: usize,
    pub asset_count: usize,
    pub file_count: usize,
    pub size_bytes: u64,
    pub kind_counts: BTreeMap<String, u32>,
    pub created: Option<String>,
    pub updated: Option<String>,
    pub description: String,
    pub tree: Vec<TreeNode>,
    pub assets: Vec<Asset>,
    pub tags: Vec<String>,
    pub scanned_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub id: String,
    pub name: String,
    pub path: String,
}

impl LibraryEntry {
    pub fn from_value(value: &Value) -> Option<Self> {
        let id = value.get("id")?.as_str()?.to_string();
        let path = value.get("path")?.as_str()?.to_string();
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.clone())
            });
        Some(Self { id, name, path })
    }
}

#[derive(Clone, Debug)]
struct ScanFile {
    name: String,
    path: PathBuf,
    rel: String,
}

fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}

fn has_ignore_marker(dir: &Path) -> bool {
    IGNORE_MARKERS.iter().any(|m| dir.join(m).exists())
}

pub fn filename(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| p.to_string_lossy().to_string())
}

fn list_files_recursive(root: &Path, out: &mut Vec<ScanFile>, depth: usize) {
    if out.len() >= MAX_SCAN_FILES || depth > MAX_SCAN_DEPTH {
        return;
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_SCAN_FILES {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".DS_Store" || name == "Thumbs.db" {
            continue;
        }
        let full = root.join(&name);
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            list_files_recursive(&full, out, depth + 1);
        } else if file_type.is_file() {
            out.push(ScanFile {
                rel: rel_path(root.parent().unwrap_or(root), &full),
                name,
                path: full,
            });
        }
    }
}

fn find_preview(files: &[ScanFile]) -> Option<ScanFile> {
    let mut best: Option<ScanFile> = None;
    let mut best_depth = usize::MAX;
    let mut best_priority = usize::MAX;

    for file in files {
        let ext = ext_of(&file.name);
        let Some(priority) = PREVIEW_PRIORITY.iter().position(|p| *p == ext) else {
            continue;
        };
        let depth = file.rel.matches('/').count();
        let better = best.is_none()
            || depth < best_depth
            || (depth == best_depth
                && (priority < best_priority
                    || (priority == best_priority
                        && file.name.len()
                            < best.as_ref().map(|b| b.name.len()).unwrap_or(usize::MAX))));
        if better {
            best = Some(file.clone());
            best_depth = depth;
            best_priority = priority;
        }
    }
    best
}

fn classify_importables(files: &[ScanFile], exclude: Option<&Path>) -> Vec<Importable> {
    files
        .iter()
        .filter(|f| exclude.map(|e| e != f.path).unwrap_or(true))
        .filter_map(|f| {
            let ext = ext_of(&f.name);
            if !IMPORTABLE_EXTENSIONS.contains(&ext.as_str()) {
                return None;
            }
            Some(Importable {
                name: f.name.clone(),
                path: f.path.to_string_lossy().to_string(),
                rel: f.rel.clone(),
                kind: ext.trim_start_matches('.').to_string(),
            })
        })
        .collect()
}

fn kind_of_ext(ext: &str) -> String {
    if ext == ".unitypackage" {
        return "unitypackage".into();
    }
    if MESH_EXTENSIONS.contains(&ext) {
        return "mesh".into();
    }
    if IMAGE_EXTENSIONS.contains(&ext) {
        return "texture".into();
    }
    if AUDIO_EXTENSIONS.contains(&ext) {
        return "audio".into();
    }
    if VIDEO_EXTENSIONS.contains(&ext) {
        return "video".into();
    }
    if FONT_EXTENSIONS.contains(&ext) {
        return "font".into();
    }
    if SCRIPT_EXTENSIONS.contains(&ext) {
        return "script".into();
    }
    if MATERIAL_EXTENSIONS.contains(&ext) {
        return "material".into();
    }
    if ext.is_empty() {
        "other".into()
    } else {
        ext.trim_start_matches('.').to_string()
    }
}

fn display_kinds(importables: &[Importable]) -> Vec<String> {
    let mut kinds: Vec<String> = importables
        .iter()
        .map(|i| kind_of_ext(&format!(".{}", i.kind)))
        .collect();
    kinds.sort();
    kinds.dedup();
    kinds
}

fn kind_counts(importables: &[Importable]) -> BTreeMap<String, u32> {
    let mut counts = BTreeMap::new();
    for item in importables {
        *counts
            .entry(kind_of_ext(&format!(".{}", item.kind)))
            .or_insert(0) += 1;
    }
    counts
}

fn asset_kind(importables: &[Importable]) -> String {
    if importables.iter().any(|i| i.kind == "unitypackage") {
        return "unitypackage".into();
    }
    if importables
        .iter()
        .any(|i| MESH_EXTENSIONS.contains(&format!(".{}", i.kind).as_str()))
    {
        return "mesh".into();
    }
    if !importables.is_empty() {
        return "asset".into();
    }
    "other".into()
}

fn size_of(files: &[ScanFile]) -> u64 {
    files
        .iter()
        .filter_map(|f| fs::metadata(&f.path).ok().map(|m| m.len()))
        .sum()
}

fn stat_info(path: &Path) -> (Option<String>, Option<String>) {
    match fs::metadata(path) {
        Ok(meta) => (
            meta.created().ok().and_then(system_time_iso),
            meta.modified().ok().and_then(system_time_iso),
        ),
        Err(_) => (None, None),
    }
}

fn aggregate_children(nodes: &[TreeNode]) -> (u32, usize, u64, BTreeMap<String, u32>, Vec<String>) {
    let mut asset_count = 0u32;
    let mut file_count = 0usize;
    let mut size_bytes = 0u64;
    let mut kinds: BTreeMap<String, u32> = BTreeMap::new();
    let mut tags: Vec<String> = Vec::new();

    for node in nodes {
        asset_count += if node.node_type == "asset" {
            1
        } else {
            node.asset_count
        };
        file_count += node.file_count;
        size_bytes += node.size_bytes;
        for (kind, count) in &node.kind_counts {
            *kinds.entry(kind.clone()).or_insert(0) += count;
        }
        for tag in &node.tags {
            if !tags.contains(tag) {
                tags.push(tag.clone());
            }
        }
    }
    tags.sort();
    (asset_count, file_count, size_bytes, kinds, tags)
}

fn max_updated(nodes: &[TreeNode], fallback: Option<String>) -> Option<String> {
    let mut best: Option<chrono::DateTime<chrono::Utc>> = fallback
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&chrono::Utc));

    for node in nodes {
        if let Some(updated) = node.updated.as_deref() {
            if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(updated) {
                let parsed = parsed.with_timezone(&chrono::Utc);
                if best.map(|b| parsed > b).unwrap_or(true) {
                    best = Some(parsed);
                }
            }
        }
    }
    match best {
        Some(dt) => Some(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        None => fallback,
    }
}

type TagsFn<'a> = &'a dyn Fn(&Path) -> Vec<String>;
type MetaFn<'a> = &'a dyn Fn(&Path) -> String;

fn scan_directory(
    lib: &LibraryEntry,
    abs: &Path,
    rel: &str,
    depth: usize,
    get_tags: TagsFn<'_>,
    get_meta: MetaFn<'_>,
) -> Option<TreeNode> {
    let name = filename(abs);
    if depth > 0 {
        if name.starts_with('.') {
            return None;
        }
        if IGNORED_DIR_NAMES.contains(&name.to_lowercase().as_str()) {
            return None;
        }
    }
    if has_ignore_marker(abs) {
        return None;
    }

    let entries = fs::read_dir(abs).ok()?;
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut direct_files: Vec<ScanFile> = Vec::new();

    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        let full = abs.join(&file_name);
        match entry.file_type() {
            Ok(t) if t.is_dir() => dirs.push(full),
            Ok(t) if t.is_file() => {
                if file_name != ".DS_Store" && file_name != "Thumbs.db" {
                    direct_files.push(ScanFile {
                        name: file_name,
                        path: full,
                        rel: String::new(),
                    });
                }
            }
            _ => {}
        }
    }

    let has_direct_preview = direct_files
        .iter()
        .any(|f| PREVIEW_PRIORITY.contains(&ext_of(&f.name).as_str()));
    let has_direct_importable = direct_files
        .iter()
        .any(|f| IMPORTABLE_EXTENSIONS.contains(&ext_of(&f.name).as_str()));

    if has_direct_preview || has_direct_importable {
        let mut files: Vec<ScanFile> = Vec::new();
        list_files_recursive(abs, &mut files, 0);
        for file in files.iter_mut() {
            file.rel = rel_path(abs, &file.path);
        }
        let preview = find_preview(&files);
        let importables = classify_importables(&files, preview.as_ref().map(|p| p.path.as_path()));
        let tags = get_tags(abs);
        let (created, updated) = stat_info(abs);
        let size_bytes = size_of(&files);
        let counts = kind_counts(&importables);
        let description = get_meta(abs);

        let asset = Asset {
            id: format!("{}:{}", lib.id, hash_string(&abs.to_string_lossy())),
            name: name.clone(),
            rel_path: rel.to_string(),
            category: rel.to_string(),
            library_id: lib.id.clone(),
            library_name: lib.name.clone(),
            folder: abs.to_string_lossy().to_string(),
            size_bytes,
            file_count: files.len(),
            kind_counts: counts.clone(),
            preview: preview.map(|p| PreviewRef {
                path: p.path.to_string_lossy().to_string(),
                rel: p.rel.replace('\\', "/"),
            }),
            importable: !importables.is_empty(),
            kinds: display_kinds(&importables),
            kind: asset_kind(&importables),
            importables,
            tags: tags.clone(),
            created: created.clone(),
            updated: updated.clone(),
            description: description.clone(),
        };

        return Some(TreeNode {
            node_type: "asset".into(),
            name,
            path: abs.to_string_lossy().to_string(),
            rel: rel.to_string(),
            count: 1,
            asset_count: 1,
            file_count: files.len(),
            size_bytes,
            kind_counts: counts,
            tags,
            created,
            updated,
            description,
            children: Vec::new(),
            asset: Some(asset),
        });
    }

    let mut children: Vec<TreeNode> = Vec::new();
    for dir in dirs {
        let child_name = filename(&dir);
        let child_rel = if rel.is_empty() {
            child_name.clone()
        } else {
            format!("{rel}/{child_name}")
        };
        if let Some(node) = scan_directory(lib, &dir, &child_rel, depth + 1, get_tags, get_meta) {
            children.push(node);
        }
    }
    if children.is_empty() {
        return None;
    }
    sort_tree(&mut children);

    let (asset_count, file_count, size_bytes, counts, tags) = aggregate_children(&children);
    let (created, updated) = stat_info(abs);
    let updated = max_updated(&children, updated);
    let description = get_meta(abs);

    Some(TreeNode {
        node_type: "container".into(),
        name,
        path: abs.to_string_lossy().to_string(),
        rel: rel.to_string(),
        count: asset_count,
        asset_count,
        file_count,
        size_bytes,
        kind_counts: counts,
        tags,
        created,
        updated,
        description,
        children,
        asset: None,
    })
}

fn sort_tree(nodes: &mut [TreeNode]) {
    nodes.sort_by(|a, b| compare_names(&a.name, &b.name));
    for node in nodes.iter_mut() {
        if node.node_type == "container" {
            sort_tree(&mut node.children);
        }
    }
}

fn flatten_tree(nodes: &[TreeNode], out: &mut Vec<Asset>) {
    for node in nodes {
        if node.node_type == "asset" {
            if let Some(asset) = &node.asset {
                out.push(asset.clone());
            }
        } else {
            flatten_tree(&node.children, out);
        }
    }
}

fn set_categories(nodes: &mut [TreeNode], parent_rel: &str) {
    for node in nodes.iter_mut() {
        if node.node_type == "asset" {
            if let Some(asset) = node.asset.as_mut() {
                asset.category = parent_rel.to_string();
            }
        } else {
            let rel = node.rel.clone();
            set_categories(&mut node.children, &rel);
        }
    }
}

fn empty_scan(lib: &LibraryEntry) -> LibraryScan {
    LibraryScan {
        id: lib.id.clone(),
        name: lib.name.clone(),
        path: lib.path.clone(),
        total_assets: 0,
        asset_count: 0,
        file_count: 0,
        size_bytes: 0,
        kind_counts: BTreeMap::new(),
        created: None,
        updated: None,
        description: String::new(),
        tree: Vec::new(),
        assets: Vec::new(),
        tags: Vec::new(),
        scanned_at: now_iso(),
    }
}

pub fn scan_library(lib: &LibraryEntry, get_tags: TagsFn<'_>, get_meta: MetaFn<'_>) -> LibraryScan {
    let root = Path::new(&lib.path);
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return empty_scan(lib),
    };

    let mut tree: Vec<TreeNode> = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let abs = root.join(&name);
        if let Some(node) = scan_directory(lib, &abs, &name, 1, get_tags, get_meta) {
            tree.push(node);
        }
    }
    sort_tree(&mut tree);
    set_categories(&mut tree, "");

    let mut assets: Vec<Asset> = Vec::new();
    flatten_tree(&tree, &mut assets);
    assets.sort_by(|a, b| compare_names(&a.name, &b.name));

    let (_, file_count, size_bytes, counts, tags) = aggregate_children(&tree);
    let (created, updated) = stat_info(root);
    let updated = max_updated(&tree, updated);
    let description = get_meta(root);

    LibraryScan {
        id: lib.id.clone(),
        name: lib.name.clone(),
        path: lib.path.clone(),
        total_assets: assets.len(),
        asset_count: assets.len(),
        file_count,
        size_bytes,
        kind_counts: counts,
        created,
        updated,
        description,
        tree,
        assets,
        tags,
        scanned_at: now_iso(),
    }
}

pub fn scan_all(
    libraries: &[LibraryEntry],
    tags: &HashMap<String, Vec<String>>,
    meta: &HashMap<String, Value>,
) -> Vec<LibraryScan> {
    libraries
        .iter()
        .map(|lib| {
            let get_tags = |p: &Path| {
                tags.get(&crate::paths::key(p))
                    .cloned()
                    .unwrap_or_default()
            };
            let get_meta = |p: &Path| {
                meta.get(&crate::paths::key(p))
                    .and_then(|entry| entry.get("description"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            scan_library(lib, &get_tags, &get_meta)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn fixture() -> (tempfile::TempDir, LibraryEntry) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("MyAssets");
        for (rel, body) in [
            ("3d/Props/Furniture/Chair/preview.png", "png"),
            ("3d/Props/Furniture/Chair/chair.fbx", "fbx"),
            ("3d/Props/Furniture/Chair/readme.txt", "hi"),
            ("3d/Props/Furniture/Vase/preview.jpg", "jpg"),
            ("3d/Props/Furniture/Vase/vase.obj", "obj"),
            ("3d/Vehicles/Car/preview.webp", "webp"),
            ("2d/GrassTex/preview.jpg", "jpg"),
            ("2d/GrassTex/grass.png", "png"),
            ("2d/Pack/preview.gif", "gif"),
            ("2d/Pack/sheet.unitypackage", "pkg"),
            (".git/config", "[core]"),
        ] {
            touch(&root, rel, body);
        }
        let lib = LibraryEntry {
            id: "lib1".into(),
            name: "MyAssets".into(),
            path: root.to_string_lossy().to_string(),
        };
        (dir, lib)
    }

    #[test]
    fn scans_nested_libraries() {
        let (_dir, lib) = fixture();
        let empty_tags = |_: &Path| Vec::new();
        let empty_meta = |_: &Path| String::new();
        let scan = scan_library(&lib, &empty_tags, &empty_meta);

        assert_eq!(scan.total_assets, 5);
        let names: Vec<_> = scan.tree.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["2d", "3d"]);

        let c3d = scan.tree.iter().find(|n| n.name == "3d").unwrap();
        assert_eq!(c3d.node_type, "container");
        assert_eq!(c3d.count, 3);
        assert_eq!(c3d.file_count, 6);
        assert_eq!(c3d.kind_counts.get("mesh"), Some(&2));
        assert!(c3d.created.is_some());

        let chair = scan.assets.iter().find(|a| a.name == "Chair").unwrap();
        assert_eq!(chair.rel_path, "3d/Props/Furniture/Chair");
        assert_eq!(chair.category, "3d/Props/Furniture");
        assert!(chair.importable);
        assert_eq!(chair.kind, "mesh");
        assert_eq!(chair.preview.as_ref().unwrap().rel, "preview.png");

        let car = scan.assets.iter().find(|a| a.name == "Car").unwrap();
        assert!(!car.importable);
        let pack = scan.assets.iter().find(|a| a.name == "Pack").unwrap();
        assert_eq!(pack.kind, "unitypackage");
    }

    #[test]
    fn forwards_tags_and_descriptions() {
        let (_dir, lib) = fixture();
        let root = PathBuf::from(&lib.path);
        let chair = root.join("3d/Props/Furniture/Chair");
        let get_tags = |p: &Path| {
            if p == chair.as_path() {
                vec!["wood".to_string(), "furniture".to_string()]
            } else {
                Vec::new()
            }
        };
        let get_meta = |p: &Path| {
            if p == chair.as_path() {
                "A wooden chair".to_string()
            } else {
                String::new()
            }
        };
        let scan = scan_library(&lib, &get_tags, &get_meta);
        let chair_asset = scan.assets.iter().find(|a| a.name == "Chair").unwrap();
        assert_eq!(chair_asset.tags, vec!["wood", "furniture"]);
        assert_eq!(chair_asset.description, "A wooden chair");
        let c3d = scan.tree.iter().find(|n| n.name == "3d").unwrap();
        assert_eq!(c3d.tags, vec!["furniture", "wood"]);
    }
}
