use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::time::now_millis;

/// JSON-backed key/value store with the same on-disk behaviour as the Node
/// build: pretty-printed JSON, atomic temp-file rename, and corruption backup.
pub struct JsonStore {
    path: PathBuf,
    data: Map<String, Value>,
}

impl JsonStore {
    pub fn open(path: impl Into<PathBuf>, seed: Map<String, Value>) -> Self {
        let path = path.into();
        let data = match fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<Value>(&raw) {
                Ok(Value::Object(map)) => map,
                Ok(_) | Err(_) => {
                    backup_corrupt(&path);
                    seed.clone()
                }
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => seed.clone(),
            Err(_) => {
                backup_corrupt(&path);
                seed.clone()
            }
        };
        let store = Self { path, data };
        if !store.path.exists() {
            store.save();
        }
        store
    }

    pub fn get(&self, key: &str) -> Value {
        self.data.get(key).cloned().unwrap_or(Value::Null)
    }

    pub fn get_object(&self, key: &str) -> Map<String, Value> {
        match self.data.get(key) {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        }
    }

    pub fn get_array(&self, key: &str) -> Vec<Value> {
        match self.data.get(key) {
            Some(Value::Array(list)) => list.clone(),
            _ => Vec::new(),
        }
    }

    pub fn set(&mut self, key: &str, value: Value) {
        self.data.insert(key.to_string(), value);
        self.save();
    }

    pub fn save(&self) {
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let tmp = self.path.with_extension("json.tmp");
        let body = serde_json::to_string_pretty(&Value::Object(self.data.clone()))
            .unwrap_or_else(|_| "{}".to_string());
        if fs::write(&tmp, body).is_ok() {
            let _ = fs::rename(&tmp, &self.path);
        }
    }
}

fn backup_corrupt(path: &Path) {
    let bak = PathBuf::from(format!(
        "{}.corrupt-{}",
        path.to_string_lossy(),
        now_millis()
    ));
    let _ = fs::rename(path, bak);
}

pub fn seed_libraries() -> Map<String, Value> {
    let mut map = BTreeMap::new();
    map.insert("libraries".to_string(), Value::Array(Vec::new()));
    map.insert(
        "server".to_string(),
        serde_json::json!({ "host": "127.0.0.1", "port": 7100 }),
    );
    map.into_iter().collect()
}

pub fn seed_jobs() -> Map<String, Value> {
    serde_json::json!({ "jobs": [] })
        .as_object()
        .cloned()
        .unwrap_or_default()
}

pub fn seed_tags() -> Map<String, Value> {
    serde_json::json!({ "tags": {} })
        .as_object()
        .cloned()
        .unwrap_or_default()
}

pub fn seed_meta() -> Map<String, Value> {
    serde_json::json!({ "meta": {} })
        .as_object()
        .cloned()
        .unwrap_or_default()
}

pub fn system_time_iso(time: SystemTime) -> Option<String> {
    let since_epoch = time.duration_since(UNIX_EPOCH).ok()?;
    let dt = chrono::DateTime::from_timestamp(
        since_epoch.as_secs() as i64,
        since_epoch.subsec_nanos(),
    )?;
    Some(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_recovers_from_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("asset-vault-settings.json");
        fs::write(&file, "{ not json").unwrap();

        let mut store = JsonStore::open(&file, seed_libraries());
        assert_eq!(store.get("libraries"), Value::Array(vec![]));
        store.set("libraries", serde_json::json!([{ "id": "lib_1" }]));
        drop(store);

        let reopened = JsonStore::open(&file, seed_libraries());
        assert_eq!(reopened.get_array("libraries").len(), 1);
        let backups: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1);
    }
}
