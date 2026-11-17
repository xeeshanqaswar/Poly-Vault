use std::collections::{HashSet, VecDeque};

use serde_json::{json, Value};

use crate::time::now_iso;

pub const WORKERS: usize = 3;
pub const MIN_GAP_MS: u64 = 150;
pub const MAX_TAGS: usize = 64;

#[derive(Clone, Debug)]
pub struct EnrichItem {
    pub path: String,
    pub name: String,
}

pub struct EnrichmentState {
    pub mode: &'static str,
    pub draining: bool,
    pub queue: VecDeque<EnrichItem>,
    pub active: HashSet<String>,
    pub done: usize,
    pub message: String,
}

impl Default for EnrichmentState {
    fn default() -> Self {
        Self {
            mode: "idle",
            draining: false,
            queue: VecDeque::new(),
            active: HashSet::new(),
            done: 0,
            message: String::new(),
        }
    }
}

impl EnrichmentState {
    pub fn refresh_message(&mut self) {
        let total = self.done + self.active.len() + self.queue.len();
        self.message = if self.active.is_empty() && self.queue.is_empty() {
            String::new()
        } else {
            format!(
                "Fetching descriptions\u{2026} {}/{}",
                self.done + self.active.len(),
                total
            )
        };
    }

    pub fn status(&self) -> Value {
        json!({
            "state": self.mode,
            "pending": self.queue.len(),
            "active": self.active.len(),
            "done": self.done,
            "message": self.message,
        })
    }
}

/// Folds a lookup result into the stored metadata record without ever wiping a
/// hand-written description just because a store lookup found nothing.
pub fn merge_meta_entry(prev: Option<&Value>, entry: &Value) -> Value {
    let blank = Value::Object(Default::default());
    let previous = prev.unwrap_or(&blank);

    let description = entry
        .get("description")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            previous
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();

    let name = entry
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            previous
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();

    let url = entry
        .get("url")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            previous
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();

    let found = match entry.get("found") {
        Some(v) => v.as_bool().unwrap_or(false),
        None => previous.get("found").and_then(Value::as_bool).unwrap_or(false),
    };

    let fetched_at = entry
        .get("fetchedAt")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            previous
                .get("fetchedAt")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(now_iso);

    json!({
        "description": description,
        "name": name,
        "url": url,
        "found": found,
        "fetchedAt": fetched_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missed_lookups_keep_manual_descriptions() {
        let prev = json!({
            "description": "Hand-written notes",
            "found": false,
            "fetchedAt": "2026-01-01T00:00:00.000Z"
        });
        let merged = merge_meta_entry(Some(&prev), &json!({ "found": false }));
        assert_eq!(merged["description"], "Hand-written notes");
        assert_eq!(merged["fetchedAt"], "2026-01-01T00:00:00.000Z");
    }

    #[test]
    fn fetched_descriptions_replace_previous_text() {
        let prev = json!({ "description": "old", "found": true });
        let merged = merge_meta_entry(
            Some(&prev),
            &json!({ "description": "new", "found": true, "name": "Chair" }),
        );
        assert_eq!(merged["description"], "new");
        assert_eq!(merged["name"], "Chair");
    }
}
