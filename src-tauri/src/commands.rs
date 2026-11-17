use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::State;

use crate::state::AppState;
use crate::unity_store;

#[tauri::command(rename_all = "camelCase")]
pub async fn add_library(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let picked = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Add asset library folder")
            .pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(dir) = picked {
        state.add_library(&dir.to_string_lossy());
    }
    Ok(state.get_state())
}

#[tauri::command(rename_all = "camelCase")]
pub fn remove_library(state: State<'_, Arc<AppState>>, id: String) -> Value {
    state.remove_library(&id);
    state.get_state()
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_state(state: State<'_, Arc<AppState>>) -> Value {
    state.get_state()
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_server_info(state: State<'_, Arc<AppState>>) -> Value {
    json!({ "host": state.bridge_host, "port": state.bridge_port })
}

#[tauri::command(rename_all = "camelCase")]
pub fn open_path(target_path: String) -> Value {
    let target = target_path.trim();
    if target.is_empty() || !Path::new(target).exists() {
        return json!({ "ok": false, "error": "path not found" });
    }
    match open::that(target) {
        Ok(_) => json!({ "ok": true, "error": "" }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn fetch_unity_description(name: String) -> Value {
    unity_store::find_and_fetch_description(&name).await
}
