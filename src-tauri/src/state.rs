use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::autotags::derive_tags;
use crate::enrichment::{
    merge_meta_entry, EnrichItem, EnrichmentState, MAX_TAGS, MIN_GAP_MS, WORKERS,
};
use crate::library::{scan_all, LibraryEntry, LibraryScan, TreeNode};
use crate::paths::{hash_string, key, resolve};
use crate::store::{seed_jobs, seed_libraries, seed_meta, seed_tags, JsonStore};
use crate::time::now_iso;
use crate::unity_store;

pub const APP_NAME: &str = "Poly Vault";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct AppState {
    pub version: String,
    pub settings: Mutex<JsonStore>,
    pub jobs: Mutex<JsonStore>,
    pub tags: Mutex<JsonStore>,
    pub meta: Mutex<JsonStore>,
    pub unity_seen: AtomicI64,
    pub enrichment: AsyncMutex<EnrichmentState>,
    pub bridge_host: String,
    pub bridge_port: u16,
}

impl AppState {
    pub fn new(user_data: PathBuf) -> Self {
        let settings = JsonStore::open(user_data.join("asset-vault-settings.json"), seed_libraries());
        let server = settings.get("server");
        let bridge_host = server
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or("127.0.0.1")
            .to_string();
        let bridge_port = server
            .get("port")
            .and_then(Value::as_u64)
            .unwrap_or(7100) as u16;

        Self {
            version: env!("CARGO_PKG_VERSION").to_string(),
            settings: Mutex::new(settings),
            jobs: Mutex::new(JsonStore::open(
                user_data.join("asset-vault-jobs.json"),
                seed_jobs(),
            )),
            tags: Mutex::new(JsonStore::open(
                user_data.join("asset-vault-tags.json"),
                seed_tags(),
            )),
            meta: Mutex::new(JsonStore::open(
                user_data.join("asset-vault-meta.json"),
                seed_meta(),
            )),
            unity_seen: AtomicI64::new(0),
            enrichment: AsyncMutex::new(EnrichmentState::default()),
            bridge_host,
            bridge_port,
        }
    }

    pub fn libraries(&self) -> Vec<LibraryEntry> {
        lock(&self.settings)
            .get_array("libraries")
            .iter()
            .filter_map(LibraryEntry::from_value)
            .collect()
    }

    pub fn library_values(&self) -> Vec<Value> {
        lock(&self.settings).get_array("libraries")
    }

    pub fn library_paths(&self) -> Vec<String> {
        self.libraries().into_iter().map(|l| l.path).collect()
    }

    pub fn jobs_list(&self) -> Vec<Value> {
        lock(&self.jobs).get_array("jobs")
    }

    pub fn save_jobs(&self, jobs: Vec<Value>) {
        lock(&self.jobs).set("jobs", Value::Array(jobs));
    }

    pub fn get_state(&self) -> Value {
        let libraries: Vec<Value> = self
            .library_values()
            .into_iter()
            .map(|mut lib| {
                if let Some(path) = lib.get("path").and_then(Value::as_str) {
                    if !Path::new(path).exists() {
                        if let Some(obj) = lib.as_object_mut() {
                            obj.insert("missing".into(), Value::Bool(true));
                        }
                    }
                }
                lib
            })
            .collect();

        json!({
            "name": APP_NAME,
            "version": self.version,
            "libraries": libraries,
            "jobs": self.jobs_list(),
        })
    }

    pub fn add_library(&self, abs: &str) -> Vec<Value> {
        let resolved = resolve(abs);
        let mut libs = self.library_values();
        let already = libs.iter().any(|l| {
            l.get("path")
                .and_then(Value::as_str)
                .map(|p| resolve(p) == resolved)
                .unwrap_or(false)
        });
        if already {
            return libs;
        }

        let path_text = resolved.to_string_lossy().to_string();
        let name = resolved
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path_text.clone());

        libs.push(json!({
            "id": format!("lib_{}", hash_string(&path_text)),
            "name": name,
            "path": path_text,
            "addedAt": now_iso(),
        }));
        lock(&self.settings).set("libraries", Value::Array(libs.clone()));
        libs
    }

    pub fn remove_library(&self, id: &str) -> Vec<Value> {
        let libs: Vec<Value> = self
            .library_values()
            .into_iter()
            .filter(|l| l.get("id").and_then(Value::as_str) != Some(id))
            .collect();
        lock(&self.settings).set("libraries", Value::Array(libs.clone()));
        libs
    }

    pub fn tags_map(&self) -> HashMap<String, Vec<String>> {
        let object = lock(&self.tags).get_object("tags");
        object
            .into_iter()
            .filter_map(|(k, v)| {
                v.as_array().map(|list| {
                    (
                        k,
                        list.iter()
                            .filter_map(|t| t.as_str().map(str::to_string))
                            .collect(),
                    )
                })
            })
            .collect()
    }

    pub fn tags_object(&self) -> Map<String, Value> {
        lock(&self.tags).get_object("tags")
    }

    pub fn meta_object(&self) -> Map<String, Value> {
        lock(&self.meta).get_object("meta")
    }

    pub fn meta_map(&self) -> HashMap<String, Value> {
        lock(&self.meta).get_object("meta").into_iter().collect()
    }

    pub fn tags_for(&self, target: &str) -> Vec<String> {
        self.tags_map().remove(&key(target)).unwrap_or_default()
    }

    pub fn set_tags(&self, target: &str, list: Vec<String>) -> Vec<String> {
        let mut store = lock(&self.tags);
        let mut all = store.get_object("tags");
        let k = key(target);
        if list.is_empty() {
            all.remove(&k);
            store.set("tags", Value::Object(all));
            return Vec::new();
        }
        all.insert(k, json!(list));
        store.set("tags", Value::Object(all));
        list
    }

    pub fn apply_bulk(&self, entries: Vec<(String, Vec<String>)>) -> usize {
        let mut store = lock(&self.tags);
        let mut all = store.get_object("tags");
        for (target, tags) in &entries {
            let k = key(target);
            if tags.is_empty() {
                all.remove(&k);
            } else {
                all.insert(k, json!(tags));
            }
        }
        store.set("tags", Value::Object(all));
        entries.len()
    }

    pub fn write_meta_entry(&self, target: &str, entry: Value) -> Value {
        let mut store = lock(&self.meta);
        let mut all = store.get_object("meta");
        let k = key(target);
        let merged = merge_meta_entry(all.get(&k), &entry);
        all.insert(k, merged.clone());
        store.set("meta", Value::Object(all));
        merged
    }

    pub fn set_meta_description(&self, target: &str, description: &str) -> String {
        let mut store = lock(&self.meta);
        let mut all = store.get_object("meta");
        let k = key(target);
        if description.is_empty() {
            all.remove(&k);
            store.set("meta", Value::Object(all));
            return String::new();
        }
        all.insert(k, json!({ "description": description }));
        store.set("meta", Value::Object(all));
        description.to_string()
    }

    pub fn scan_libraries(&self) -> Vec<LibraryScan> {
        let libs = self.libraries();
        let tags = self.tags_map();
        let meta = self.meta_map();
        scan_all(&libs, &tags, &meta)
    }

    pub fn run_update(&self, scope: &Value) -> (Vec<LibraryScan>, Vec<Value>) {
        let libraries = self.scan_libraries();
        let scope_type = scope.get("type").and_then(Value::as_str).unwrap_or("all");
        let lib_id = scope.get("libId").and_then(Value::as_str).unwrap_or("");
        let mut targets: Vec<Value> = Vec::new();

        for lib in &libraries {
            let in_scope =
                scope_type == "all" || (scope_type == "library" && lib.id == lib_id);
            if in_scope {
                for asset in &lib.assets {
                    targets.push(json!({ "path": asset.folder, "name": asset.name }));
                }
            }
        }

        if (scope_type == "asset" || scope_type == "container") && !lib_id.is_empty() {
            if let Some(lib) = libraries.iter().find(|l| l.id == lib_id) {
                let rel = scope.get("rel").and_then(Value::as_str).unwrap_or("");
                if let Some(node) = find_node(&lib.tree, rel) {
                    if node.node_type == "asset" {
                        if let Some(asset) = &node.asset {
                            targets.push(json!({ "path": asset.folder, "name": asset.name }));
                        }
                    } else {
                        let paths: HashSet<String> =
                            collect_asset_paths(node).into_iter().collect();
                        for asset in &lib.assets {
                            if paths.contains(&asset.folder) {
                                targets.push(json!({ "path": asset.folder, "name": asset.name }));
                            }
                        }
                    }
                }
            }
        }

        (libraries, targets)
    }

    pub async fn enrichment_status(&self) -> Value {
        self.enrichment.lock().await.status()
    }

    pub async fn enrichment_request(self: &Arc<Self>, items: Vec<EnrichItem>, force: bool) -> usize {
        if items.is_empty() {
            return 0;
        }
        let meta = self.meta_map();
        let mut added = 0usize;

        {
            let mut state = self.enrichment.lock().await;
            let active: HashSet<String> = state.active.clone();
            let mut queued: HashSet<String> =
                state.queue.iter().map(|i| i.path.clone()).collect();

            for item in items {
                if item.path.is_empty() {
                    continue;
                }
                if let Some(entry) = meta.get(&key(&item.path)) {
                    let fetched = entry.get("fetchedAt").is_some();
                    let found = entry.get("found").and_then(Value::as_bool).unwrap_or(false);
                    if fetched && !(force && !found) {
                        continue;
                    }
                }
                if active.contains(&item.path) || queued.contains(&item.path) {
                    continue;
                }
                queued.insert(item.path.clone());
                state.queue.push_back(EnrichItem {
                    name: if item.name.is_empty() {
                        item.path.clone()
                    } else {
                        item.name
                    },
                    path: item.path,
                });
                added += 1;
            }

            if added > 0 {
                state.refresh_message();
            }
        }

        if added > 0 {
            start_drain(Arc::clone(self));
        }
        added
    }
}

fn start_drain(state: Arc<AppState>) {
    tokio::spawn(async move {
        {
            let mut enrichment = state.enrichment.lock().await;
            if enrichment.draining {
                return;
            }
            enrichment.draining = true;
            enrichment.mode = "fetching";
            enrichment.done = 0;
        }

        let mut lanes = Vec::new();
        for _ in 0..WORKERS {
            let lane_state = Arc::clone(&state);
            lanes.push(tokio::spawn(async move { lane(lane_state).await }));
        }
        for handle in lanes {
            let _ = handle.await;
        }

        let more = {
            let mut enrichment = state.enrichment.lock().await;
            enrichment.mode = "idle";
            enrichment.done = 0;
            enrichment.message.clear();
            enrichment.draining = false;
            !enrichment.queue.is_empty()
        };
        if more {
            start_drain(state);
        }
    });
}

async fn lane(state: Arc<AppState>) {
    loop {
        let item = {
            let mut enrichment = state.enrichment.lock().await;
            enrichment.queue.pop_front()
        };
        let Some(item) = item else { return };

        {
            let mut enrichment = state.enrichment.lock().await;
            if enrichment.active.contains(&item.path) {
                continue;
            }
            enrichment.active.insert(item.path.clone());
            enrichment.refresh_message();
        }

        let started = Instant::now();
        let result = unity_store::find_and_fetch_description(&item.name).await;

        let found = result
            .get("found")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if found {
            let category = result
                .get("category")
                .and_then(Value::as_str)
                .unwrap_or("");
            let description = result
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            let derived = derive_tags(&item.name, category, description);
            if !derived.is_empty() {
                let mut merged: Vec<String> =
                    state.tags_for(&item.path).into_iter().chain(derived).collect();
                merged.sort();
                merged.dedup();
                merged.truncate(MAX_TAGS);
                state.set_tags(&item.path, merged);
            }
        }

        let entry = json!({
            "description": result.get("description").cloned().unwrap_or(json!("")),
            "name": result.get("name").cloned().unwrap_or(json!("")),
            "url": result.get("url").cloned().unwrap_or(json!("")),
            "found": found,
        });
        state.write_meta_entry(&item.path, entry);

        {
            let mut enrichment = state.enrichment.lock().await;
            enrichment.active.remove(&item.path);
            enrichment.done += 1;
            enrichment.refresh_message();
        }

        let elapsed = started.elapsed().as_millis() as u64;
        if elapsed < MIN_GAP_MS {
            tokio::time::sleep(Duration::from_millis(MIN_GAP_MS - elapsed)).await;
        }
    }
}

fn find_node<'a>(nodes: &'a [TreeNode], rel: &str) -> Option<&'a TreeNode> {
    for node in nodes {
        if node.rel == rel {
            return Some(node);
        }
        if !node.children.is_empty() {
            if let Some(hit) = find_node(&node.children, rel) {
                return Some(hit);
            }
        }
    }
    None
}

fn collect_asset_paths(node: &TreeNode) -> Vec<String> {
    if node.node_type == "asset" {
        return node
            .asset
            .as_ref()
            .map(|a| vec![a.folder.clone()])
            .unwrap_or_default();
    }
    let mut out = Vec::new();
    for child in &node.children {
        out.extend(collect_asset_paths(child));
    }
    out
}

pub fn user_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("ASSETVAULT_USER_DATA") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_NAME)
}

pub fn migrate_user_data(dest: &Path) {
    if std::env::var_os("ASSETVAULT_USER_DATA").is_some() {
        return;
    }
    if !dest
        .file_name()
        .map(|n| n.to_string_lossy().eq_ignore_ascii_case("poly vault"))
        .unwrap_or(false)
    {
        return;
    }
    let Some(parent) = dest.parent() else { return };
    let old = parent.join("Asset Vault");
    if !old.exists() || dest.exists() {
        return;
    }
    let _ = fs::create_dir_all(dest);
    for file in [
        "asset-vault-settings.json",
        "asset-vault-jobs.json",
        "asset-vault-tags.json",
        "asset-vault-meta.json",
    ] {
        let src = old.join(file);
        if src.exists() {
            let _ = fs::copy(&src, dest.join(file));
        }
    }
}

pub fn create_job(
    asset_id: &str,
    name: &str,
    category: &str,
    library_name: &str,
    folder: &str,
    tags: Vec<String>,
    importables: Vec<Value>,
) -> Value {
    let importables: Vec<Value> = importables
        .into_iter()
        .map(|item| {
            json!({
                "name": item.get("name").cloned().unwrap_or(json!("")),
                "path": item.get("path").cloned().unwrap_or(json!("")),
                "rel": item.get("rel").cloned().unwrap_or(json!("")),
                "kind": item.get("kind").cloned().unwrap_or(json!("")),
            })
        })
        .collect();
    let now = now_iso();
    json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "assetId": asset_id,
        "assetName": name,
        "category": category,
        "libraryName": library_name,
        "assetFolder": folder,
        "tags": tags,
        "importables": importables,
        "status": "pending",
        "createdAt": now,
        "updatedAt": now,
        "note": "",
    })
}

pub fn prune_jobs(jobs: Vec<Value>, max_terminal: usize) -> Vec<Value> {
    let mut active = Vec::new();
    let mut terminal = Vec::new();
    for job in jobs {
        let status = job.get("status").and_then(Value::as_str).unwrap_or("");
        if status == "done" || status == "failed" {
            terminal.push(job);
        } else {
            active.push(job);
        }
    }
    if terminal.len() > max_terminal {
        terminal.drain(0..terminal.len() - max_terminal);
    }
    terminal.extend(active);
    terminal
}

pub fn unity_seen_now(state: &AppState) -> i64 {
    let now = chrono::Utc::now().timestamp_millis();
    state.unity_seen.store(now, Ordering::SeqCst);
    now
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str, status: &str) -> Value {
        json!({ "id": id, "status": status })
    }

    #[test]
    fn prunes_oldest_terminal_jobs_only() {
        let jobs = vec![
            job("1", "done"),
            job("2", "failed"),
            job("3", "done"),
            job("4", "pending"),
            job("5", "processing"),
        ];
        let pruned = prune_jobs(jobs, 2);
        let ids: Vec<&str> = pruned
            .iter()
            .map(|j| j.get("id").unwrap().as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["2", "3", "4", "5"]);
    }

    #[test]
    fn state_round_trips_libraries_and_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().to_path_buf());
        let libs = state.add_library("C:/Assets/MyPack");
        assert_eq!(libs.len(), 1);
        assert!(libs[0]["id"].as_str().unwrap().starts_with("lib_"));

        let again = state.add_library("C:/Assets/MyPack");
        assert_eq!(again.len(), 1);

        let removed = state.remove_library(libs[0]["id"].as_str().unwrap());
        assert!(removed.is_empty());
        assert_eq!(state.libraries().len(), 0);
    }
}
