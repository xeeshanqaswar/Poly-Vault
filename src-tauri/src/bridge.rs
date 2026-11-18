use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::io::ReaderStream;
use tower_http::cors::CorsLayer;

use crate::enrichment::EnrichItem;
use crate::library::LibraryScan;
use crate::mcp;
use crate::state::{create_job, prune_jobs, unity_seen_now, AppState, APP_NAME};
use crate::time::now_iso;

const MAX_TERMINAL_JOBS: usize = 200;
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

const ALLOWED_PREVIEW_EXT: &[&str] = &[".png", ".jpg", ".jpeg", ".webp", ".gif"];

fn enrichment_enabled() -> bool {
    std::env::var("ASSETVAULT_NO_ENRICH")
        .map(|v| v != "1")
        .unwrap_or(true)
}

fn json_res(status: StatusCode, payload: Value) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        payload.to_string(),
    )
        .into_response()
}

fn error_res(status: StatusCode, message: &str) -> Response {
    json_res(status, json!({ "ok": false, "error": message }))
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/status", get(status))
        .route("/api/library", get(library))
        .route("/api/agents", get(agents))
        .route(
            "/mcp",
            get(mcp_get).post(mcp_post).delete(mcp_delete),
        )
        .route("/api/enrichment", get(enrichment))
        .route("/api/update", post(update))
        .route("/api/meta", get(meta_list).put(meta_set))
        .route("/api/tags", get(tags_list).put(tags_set))
        .route("/api/tags/apply", post(tags_apply))
        .route("/api/preview", get(preview))
        .route("/api/import-job", post(import_job))
        .route("/api/import-jobs", get(import_jobs))
        .route("/api/unity/import-jobs", get(unity_jobs))
        .route(
            "/api/unity/import-jobs/{job_id}/{action}",
            post(unity_job_status),
        )
        .route("/__diag", get(diag))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn status(State(state): State<Arc<AppState>>) -> Response {
    let libraries: Vec<Value> = state
        .libraries()
        .into_iter()
        .map(|lib| json!({ "id": lib.id, "name": lib.name, "path": lib.path }))
        .collect();

    json_res(
        StatusCode::OK,
        json!({
            "ok": true,
            "name": APP_NAME,
            "version": state.version,
            "time": now_iso(),
            "libraryCount": libraries.len(),
            "libraries": libraries,
            "unitySeenAt": state.unity_seen.load(Ordering::SeqCst),
        }),
    )
}

fn asset_items(scans: &[LibraryScan]) -> Vec<EnrichItem> {
    scans
        .iter()
        .flat_map(|lib| lib.assets.iter())
        .map(|asset| EnrichItem {
            path: asset.folder.clone(),
            name: asset.name.clone(),
        })
        .collect()
}

async fn library(State(state): State<Arc<AppState>>) -> Response {
    let scan_state = Arc::clone(&state);
    let scans = tokio::task::spawn_blocking(move || scan_state.scan_libraries())
        .await
        .unwrap_or_default();

    if enrichment_enabled() {
        state.enrichment_request(asset_items(&scans), false).await;
    }

    json_res(
        StatusCode::OK,
        json!({ "ok": true, "libraries": scans, "serverTime": now_iso() }),
    )
}

async fn enrichment(State(state): State<Arc<AppState>>) -> Response {
    let status = state.enrichment_status().await;
    json_res(StatusCode::OK, json!({ "ok": true, "status": status }))
}

#[derive(Deserialize)]
struct UpdateBody {
    #[serde(default)]
    scope: Option<Value>,
}

async fn update(State(state): State<Arc<AppState>>, Json(body): Json<UpdateBody>) -> Response {
    let scope = sanitize_scope(body.scope.as_ref());
    let update_state = Arc::clone(&state);
    let scope_for_run = scope.clone();
    let (libraries, targets) = tokio::task::spawn_blocking(move || {
        update_state.run_update(&scope_for_run)
    })
    .await
    .unwrap_or_default();

    let enabled = enrichment_enabled();
    if enabled && !targets.is_empty() {
        let items: Vec<EnrichItem> = targets
            .iter()
            .map(|t| EnrichItem {
                path: t.get("path").and_then(Value::as_str).unwrap_or("").to_string(),
                name: t.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
            })
            .collect();
        state.enrichment_request(items, true).await;
    }

    let status = if enabled {
        Some(state.enrichment_status().await)
    } else {
        None
    };

    json_res(
        StatusCode::OK,
        json!({ "ok": true, "libraries": libraries, "targets": targets, "status": status }),
    )
}

async fn meta_list(State(state): State<Arc<AppState>>) -> Response {
    json_res(
        StatusCode::OK,
        json!({ "ok": true, "meta": Value::Object(state.meta_object()) }),
    )
}

#[derive(Deserialize)]
struct PathBody {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    description: Option<Value>,
    #[serde(default)]
    tags: Option<Value>,
}

async fn meta_set(State(state): State<Arc<AppState>>, Json(body): Json<PathBody>) -> Response {
    let Some(target) = body.path.clone().filter(|p| !p.is_empty()) else {
        return error_res(StatusCode::BAD_REQUEST, "missing path");
    };
    if !crate::paths::within_library(&target, &state.library_paths()) {
        return error_res(StatusCode::FORBIDDEN, "path outside libraries");
    }
    let description = body
        .description
        .as_ref()
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let saved = state.set_meta_description(&target, &description);
    json_res(
        StatusCode::OK,
        json!({ "ok": true, "path": target, "description": saved }),
    )
}

async fn tags_list(State(state): State<Arc<AppState>>) -> Response {
    json_res(
        StatusCode::OK,
        json!({ "ok": true, "tags": Value::Object(state.tags_object()) }),
    )
}

async fn tags_set(State(state): State<Arc<AppState>>, Json(body): Json<PathBody>) -> Response {
    let Some(target) = body.path.clone().filter(|p| !p.is_empty()) else {
        return error_res(StatusCode::BAD_REQUEST, "missing path");
    };
    if !crate::paths::within_library(&target, &state.library_paths()) {
        return error_res(StatusCode::FORBIDDEN, "path outside libraries");
    }

    let mut list = normalize_tag_list(body.tags.as_ref());
    list.truncate(64);
    let saved = state.set_tags(&target, list);
    json_res(StatusCode::OK, json!({ "ok": true, "path": target, "tags": saved }))
}

#[derive(Deserialize)]
struct ApplyBody {
    #[serde(default)]
    paths: Option<Value>,
    #[serde(default)]
    add: Option<Value>,
    #[serde(default)]
    remove: Option<Value>,
}

async fn tags_apply(State(state): State<Arc<AppState>>, Json(body): Json<ApplyBody>) -> Response {
    let paths: Vec<String> = body
        .paths
        .as_ref()
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_default();

    if paths.is_empty() {
        return error_res(StatusCode::BAD_REQUEST, "missing paths");
    }

    let libraries = state.library_paths();
    for path in &paths {
        if !crate::paths::within_library(path, &libraries) {
            return error_res(StatusCode::FORBIDDEN, "path outside libraries");
        }
    }

    let add = normalize_tag_list(body.add.as_ref());
    let remove: HashSet<String> = normalize_tag_list(body.remove.as_ref()).into_iter().collect();
    let all = state.tags_map();
    let mut entries = Vec::new();

    for path in &paths {
        let current = all
            .get(&crate::paths::key(path))
            .cloned()
            .unwrap_or_default();
        let mut list: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for tag in current {
            if !remove.contains(&tag) && seen.insert(tag.clone()) {
                list.push(tag);
            }
        }
        for tag in &add {
            if seen.insert(tag.clone()) {
                list.push(tag.clone());
            }
        }
        list.truncate(64);
        entries.push((path.clone(), list));
    }

    let count = state.apply_bulk(entries);
    json_res(StatusCode::OK, json!({ "ok": true, "count": count }))
}

#[derive(Deserialize)]
struct PreviewQuery {
    #[serde(default)]
    path: Option<String>,
}

async fn preview(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PreviewQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(target) = query.path.filter(|p| !p.is_empty()) else {
        return error_res(StatusCode::BAD_REQUEST, "missing path");
    };

    let ext = Path::new(&target)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    if !ALLOWED_PREVIEW_EXT.contains(&ext.as_str()) {
        return error_res(StatusCode::BAD_REQUEST, "forbidden extension");
    }
    if !crate::paths::within_library(&target, &state.library_paths()) {
        return error_res(StatusCode::FORBIDDEN, "path outside libraries");
    }

    let path = PathBuf::from(&target);
    let meta = match std::fs::metadata(&path) {
        Ok(meta) => meta,
        Err(_) => return error_res(StatusCode::NOT_FOUND, "not found"),
    };
    let modified = meta.modified().unwrap_or(UNIX_EPOCH);
    let mtime_ms = modified
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let etag = format!("W/\"{:x}-{:x}\"", meta.len(), mtime_ms);

    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let if_modified_since = headers
        .get(header::IF_MODIFIED_SINCE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let not_modified = match &if_none_match {
        Some(value) => value.split(',').any(|candidate| candidate.trim() == etag),
        None => if_modified_since
            .as_deref()
            .and_then(|v| httpdate::parse_http_date(v).ok())
            .map(|since| {
                since >= UNIX_EPOCH + Duration::from_secs((mtime_ms / 1000) as u64)
            })
            .unwrap_or(false),
    };

    let mime = match ext.as_str() {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        _ => "application/octet-stream",
    };

    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .header(header::ETAG, etag)
        .header(header::LAST_MODIFIED, httpdate::fmt_http_date(modified));

    if not_modified {
        return builder
            .status(StatusCode::NOT_MODIFIED)
            .body(Body::empty())
            .unwrap_or_else(|_| error_res(StatusCode::INTERNAL_SERVER_ERROR, "response error"));
    }

    match tokio::fs::File::open(&path).await {
        Ok(file) => {
            builder = builder.header(header::CONTENT_LENGTH, meta.len());
            builder
                .status(StatusCode::OK)
                .body(Body::from_stream(ReaderStream::new(file)))
                .unwrap_or_else(|_| {
                    error_res(StatusCode::INTERNAL_SERVER_ERROR, "response error")
                })
        }
        Err(_) => error_res(StatusCode::NOT_FOUND, "not found"),
    }
}

#[derive(Deserialize)]
struct ImportJobBody {
    #[serde(default, rename = "assetId")]
    asset_id: Option<String>,
    #[serde(default, rename = "assetName")]
    asset_name: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default, rename = "libraryName")]
    library_name: Option<String>,
    #[serde(default, rename = "assetFolder")]
    asset_folder: Option<String>,
    #[serde(default)]
    tags: Option<Value>,
    #[serde(default)]
    importables: Option<Value>,
}

async fn import_job(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ImportJobBody>,
) -> Response {
    let Some(folder) = body.asset_folder.clone().filter(|f| !f.is_empty()) else {
        return error_res(StatusCode::BAD_REQUEST, "missing assetFolder");
    };
    let importables = body
        .importables
        .as_ref()
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if importables.is_empty() {
        return error_res(StatusCode::BAD_REQUEST, "asset has nothing importable");
    }
    if !crate::paths::within_library(&folder, &state.library_paths()) {
        return error_res(StatusCode::FORBIDDEN, "asset outside libraries");
    }

    let tags: Vec<String> = body
        .tags
        .as_ref()
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|t| t.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let job = create_job(
        body.asset_id.as_deref().unwrap_or(""),
        body.asset_name.as_deref().unwrap_or(""),
        body.category.as_deref().unwrap_or(""),
        body.library_name.as_deref().unwrap_or(""),
        &folder,
        tags,
        importables,
    );

    let mut jobs = state.jobs_list();
    jobs.push(job.clone());
    let jobs = prune_jobs(jobs, MAX_TERMINAL_JOBS);
    state.save_jobs(jobs);

    json_res(StatusCode::CREATED, json!({ "ok": true, "job": job }))
}

async fn import_jobs(State(state): State<Arc<AppState>>) -> Response {
    json_res(
        StatusCode::OK,
        json!({ "ok": true, "jobs": state.jobs_list() }),
    )
}

async fn unity_jobs(State(state): State<Arc<AppState>>) -> Response {
    unity_seen_now(&state);
    let jobs: Vec<Value> = state
        .jobs_list()
        .into_iter()
        .filter(|j| {
            let status = j.get("status").and_then(Value::as_str).unwrap_or("");
            status != "done" && status != "failed"
        })
        .collect();
    json_res(StatusCode::OK, json!({ "ok": true, "jobs": jobs }))
}

#[derive(Deserialize)]
struct NoteBody {
    #[serde(default)]
    note: Option<String>,
}

async fn unity_job_status(
    State(state): State<Arc<AppState>>,
    AxumPath((job_id, action)): AxumPath<(String, String)>,
    body: axum::body::Bytes,
) -> Response {
    if !matches!(action.as_str(), "complete" | "failed" | "processing") {
        return json_res(
            StatusCode::NOT_FOUND,
            json!({ "ok": false, "error": "not found" }),
        );
    }
    unity_seen_now(&state);

    let status = match action.as_str() {
        "complete" => "done",
        "failed" => "failed",
        _ => "processing",
    };
    let note = serde_json::from_slice::<NoteBody>(&body)
        .ok()
        .and_then(|b| b.note)
        .unwrap_or_default();

    let mut jobs = state.jobs_list();
    let Some(job) = jobs
        .iter_mut()
        .find(|j| j.get("id").and_then(Value::as_str) == Some(job_id.as_str()))
    else {
        return json_res(
            StatusCode::NOT_FOUND,
            json!({ "ok": false, "error": "job not found" }),
        );
    };

    if let Some(obj) = job.as_object_mut() {
        obj.insert("status".into(), json!(status));
        obj.insert("note".into(), json!(note));
        obj.insert("updatedAt".into(), json!(now_iso()));
    }
    let updated = job.clone();
    let jobs = prune_jobs(jobs, MAX_TERMINAL_JOBS);
    state.save_jobs(jobs);

    json_res(StatusCode::OK, json!({ "ok": true, "job": updated }))
}

async fn agents(State(state): State<Arc<AppState>>) -> Response {
    let mut payload = mcp::snapshot(&state);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("ok".into(), json!(true));
        obj.insert("serverTime".into(), json!(now_iso()));
    }
    json_res(StatusCode::OK, payload)
}

fn with_session(response: Response, session: Option<String>) -> Response {
    if let Some(id) = session {
        if let Ok(value) = axum::http::HeaderValue::from_str(&id) {
            let mut response = response;
            response.headers_mut().insert("mcp-session-id", value);
            return response;
        }
    }
    response
}

async fn mcp_post(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let session = headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let Ok(parsed) = serde_json::from_slice::<Value>(&body) else {
        return json_res(
            StatusCode::BAD_REQUEST,
            json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } }),
        );
    };

    let call_state = Arc::clone(&state);
    let (payload, session_id) = tokio::task::spawn_blocking(move || {
        mcp::handle_rpc(&call_state, &parsed, session.as_deref())
    })
    .await
    .unwrap_or((None, None));

    match payload {
        Some(value) => with_session(json_res(StatusCode::OK, value), session_id),
        None => with_session(StatusCode::ACCEPTED.into_response(), session_id),
    }
}

async fn mcp_delete(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let session = headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    mcp::close_session(&state, session.as_deref());
    StatusCode::OK.into_response()
}

async fn mcp_get() -> Response {
    Response::builder()
        .status(StatusCode::METHOD_NOT_ALLOWED)
        .header(header::ALLOW, "POST, DELETE")
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .body(Body::from(
            json!({ "ok": false, "error": "MCP stream is POST-only" }).to_string(),
        ))
        .unwrap_or_else(|_| error_res(StatusCode::INTERNAL_SERVER_ERROR, "response error"))
}

async fn diag() -> Response {
    json_res(
        StatusCode::OK,
        json!({ "ok": true, "error": "diag not wired in the Rust build" }),
    )
}

fn sanitize_scope(raw: Option<&Value>) -> Value {
    let allowed = ["all", "library", "container", "asset"];
    let kind = raw
        .and_then(|r| r.get("type"))
        .and_then(Value::as_str)
        .filter(|t| allowed.contains(t))
        .unwrap_or("all");

    let mut scope = json!({ "type": kind });
    if let Some(lib) = raw.and_then(|r| r.get("libId")).and_then(Value::as_str) {
        scope["libId"] = json!(lib);
    }
    if let Some(rel) = raw.and_then(|r| r.get("rel")).and_then(Value::as_str) {
        scope["rel"] = json!(rel);
    }
    scope
}

fn normalize_tag_list(value: Option<&Value>) -> Vec<String> {
    let Some(list) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for tag in list {
        let tag = tag
            .as_str()
            .unwrap_or("")
            .trim()
            .to_lowercase();
        if !tag.is_empty() && seen.insert(tag.clone()) {
            out.push(tag);
        }
    }
    out
}

pub async fn serve(state: Arc<AppState>) -> Result<(), String> {
    let address = format!("{}:{}", state.bridge_host, state.bridge_port);
    let listener = tokio::net::TcpListener::bind(&address)
        .await
        .map_err(|e| format!("bridge bind failed on {address}: {e}"))?;
    axum::serve(listener, router(state))
        .await
        .map_err(|e| e.to_string())
}

#[allow(dead_code)]
fn system_time_ms(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn normalizes_and_dedupes_tags_in_order() {
        let tags = normalize_tag_list(Some(&json!([" Wood ", "Furniture", "  ", "wood"])));
        assert_eq!(tags, vec!["wood", "furniture"]);
    }

    #[test]
    fn sanitizes_update_scopes() {
        assert_eq!(sanitize_scope(None)["type"], "all");
        assert_eq!(sanitize_scope(Some(&json!({ "type": "bogus" })))["type"], "all");
        let scope = sanitize_scope(Some(&json!({ "type": "asset", "libId": "lib1", "rel": "3d/Chair" })));
        assert_eq!(scope["type"], "asset");
        assert_eq!(scope["libId"], "lib1");
        assert_eq!(scope["rel"], "3d/Chair");
    }

    fn library_fixture() -> (tempfile::TempDir, Arc<AppState>) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Lib");
        let chair = root.join("3d/Chair");
        fs::create_dir_all(&chair).unwrap();
        fs::write(chair.join("preview.png"), b"fake-png").unwrap();
        fs::write(chair.join("chair.fbx"), b"fake-fbx").unwrap();

        let state = Arc::new(AppState::new(dir.path().join("data")));
        state.add_library(&root.to_string_lossy());
        (dir, state)
    }

    async fn spawn(state: Arc<AppState>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router(state)).await;
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn serves_mcp_agents_and_exports() {
        std::env::set_var("ASSETVAULT_NO_ENRICH", "1");
        let (dir, state) = library_fixture();
        let base = spawn(Arc::clone(&state)).await;
        let client = reqwest::Client::new();

        let init = client
            .post(format!("{base}/mcp"))
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "clientInfo": { "name": "http-agent", "version": "1.0.0" },
                    "capabilities": {}
                }
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(init.status(), 200);
        let session = init
            .headers()
            .get("mcp-session-id")
            .expect("mcp session header")
            .to_str()
            .unwrap()
            .to_string();
        let init_json: Value = init.json().await.unwrap();
        assert_eq!(init_json["result"]["serverInfo"]["name"], "poly-vault");

        let tools: Value = client
            .post(format!("{base}/mcp"))
            .header("Mcp-Session-Id", &session)
            .json(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 5);

        let project = dir.path().join("project");
        let export: Value = client
            .post(format!("{base}/mcp"))
            .header("Mcp-Session-Id", &session)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "poly_vault_export_asset",
                    "arguments": {
                        "name": "Chair",
                        "destination": project.to_string_lossy(),
                        "subfolder": "Assets"
                    }
                }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(export["result"]["structuredContent"]["copied"], 1);
        assert!(project.join("Assets/Chair/chair.fbx").is_file());

        let blocked: Value = client
            .post(format!("{base}/mcp"))
            .header("Mcp-Session-Id", &session)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "poly_vault_export_asset",
                    "arguments": {
                        "name": "Chair",
                        "destination": dir.path().join("Lib").to_string_lossy()
                    }
                }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(blocked["result"]["isError"], true);

        let agents: Value = client
            .get(format!("{base}/api/agents"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(agents["ok"], true);
        assert_eq!(agents["agents"][0]["name"], "http-agent");
        assert_eq!(agents["agents"][0]["connected"], true);
        assert_eq!(agents["exports"][0]["assetName"], "Chair");
        assert!(agents["mcp"]["url"]
            .as_str()
            .unwrap()
            .ends_with("/mcp"));

        let get_mcp = client
            .get(format!("{base}/mcp"))
            .send()
            .await
            .unwrap();
        assert_eq!(get_mcp.status(), 405);
    }

    #[tokio::test]
    async fn serves_scan_tags_and_import_jobs() {
        std::env::set_var("ASSETVAULT_NO_ENRICH", "1");
        let (dir, state) = library_fixture();
        let base = spawn(Arc::clone(&state)).await;
        let client = reqwest::Client::new();

        let status: Value = client
            .get(format!("{base}/api/status"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(status["ok"], true);
        assert_eq!(status["libraryCount"], 1);

        let library: Value = client
            .get(format!("{base}/api/library"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let assets = library["libraries"][0]["assets"].as_array().unwrap();
        assert_eq!(assets.len(), 1);
        let folder = assets[0]["folder"].as_str().unwrap().to_string();
        let preview = assets[0]["preview"]["path"].as_str().unwrap().to_string();

        let outside = client
            .put(format!("{base}/api/tags"))
            .json(&json!({ "path": dir.path().join("outside.png").to_string_lossy(), "tags": ["x"] }))
            .send()
            .await
            .unwrap();
        assert_eq!(outside.status(), 403);

        let tagged: Value = client
            .put(format!("{base}/api/tags"))
            .json(&json!({ "path": folder, "tags": ["Wood", " wood ", ""] }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(tagged["tags"], json!(["wood"]));

        let preview_res = client
            .get(format!("{base}/api/preview"))
            .query(&[("path", &preview)])
            .send()
            .await
            .unwrap();
        assert_eq!(preview_res.status(), 200);
        let etag = preview_res
            .headers()
            .get("etag")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        let revalidated = client
            .get(format!("{base}/api/preview"))
            .query(&[("path", &preview)])
            .header("If-None-Match", etag)
            .send()
            .await
            .unwrap();
        assert_eq!(revalidated.status(), 304);

        let job: Value = client
            .post(format!("{base}/api/import-job"))
            .json(&json!({
                "assetId": "a1",
                "assetName": "Chair",
                "category": "3d",
                "libraryName": "Lib",
                "assetFolder": folder,
                "tags": ["wood"],
                "importables": [{ "name": "chair.fbx", "path": "x", "rel": "chair.fbx", "kind": "fbx" }]
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(job["job"]["status"], "pending");

        let active: Value = client
            .get(format!("{base}/api/unity/import-jobs"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(active["jobs"].as_array().unwrap().len(), 1);
        let after: Value = client
            .get(format!("{base}/api/status"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(after["unitySeenAt"].as_i64().unwrap_or(0) > 0);
    }
}
