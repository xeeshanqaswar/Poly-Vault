use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::library::{Asset, LibraryScan};
use crate::paths;
use crate::state::AppState;
use crate::time::now_iso;

pub const PROTOCOL_VERSION: &str = "2025-06-18";
pub const MAX_EXPORTS: usize = 200;
pub const AGENT_TTL_MS: i64 = 10 * 60 * 1000;
const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 50;
const MAX_EXPORT_FILES: usize = 2000;
const MAX_RECORDED_FILES: usize = 200;
const MAX_COPY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const IGNORED_MARKERS: &[&str] = &[".assetvault-ignore", ".nomedia", ".DS_Store", "Thumbs.db"];

#[derive(Debug)]
pub struct AgentError {
    pub message: String,
    #[allow(dead_code)]
    pub code: &'static str,
}

impl AgentError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: "invalid_request",
        }
    }

    fn coded(message: impl Into<String>, code: &'static str) -> Self {
        Self {
            message: message.into(),
            code,
        }
    }
}

#[derive(Clone, Debug)]
pub struct AgentSession {
    pub id: String,
    pub name: String,
    pub version: String,
    pub connected_at: i64,
    pub last_seen_at: i64,
    pub calls: u64,
    pub last_tool: String,
    pub tools: HashMap<String, u64>,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn norm(p: &Path) -> String {
    paths::key(p).replace('\\', "/").to_lowercase()
}

pub fn within_text(target: &Path, root: &Path) -> bool {
    let t = norm(target);
    let r = norm(root);
    t == r || t.starts_with(&format!("{}/", r.trim_end_matches('/')))
}

fn protected_roots() -> Vec<PathBuf> {
    ["WINDIR", "SystemRoot", "ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .collect()
}

pub fn assert_destination(raw: Option<&Value>, libraries: &[String]) -> Result<PathBuf, AgentError> {
    let Some(text) = raw.and_then(Value::as_str).map(str::trim) else {
        return Err(AgentError::new("destination is required"));
    };
    if text.is_empty() {
        return Err(AgentError::new("destination is required"));
    }
    if !Path::new(text).is_absolute() {
        return Err(AgentError::new("destination must be an absolute path"));
    }
    let resolved = paths::resolve(text);
    if resolved.parent().is_none() {
        return Err(AgentError::new("destination cannot be a filesystem root"));
    }
    for root in protected_roots() {
        if within_text(&resolved, &root) {
            return Err(AgentError::new("destination is a protected system folder"));
        }
    }
    for lib in libraries {
        if within_text(&resolved, Path::new(lib)) {
            return Err(AgentError::new("destination is inside a Poly Vault library"));
        }
    }
    Ok(resolved)
}

pub fn sanitize_subfolder(raw: Option<&Value>) -> Result<PathBuf, AgentError> {
    let Some(value) = raw else {
        return Ok(PathBuf::new());
    };
    if value.is_null() {
        return Ok(PathBuf::new());
    }
    let Some(text) = value.as_str() else {
        return Err(AgentError::new("subfolder must be a string"));
    };
    if text.is_empty() {
        return Ok(PathBuf::new());
    }
    if text.starts_with('/') || text.starts_with('\\') || Path::new(text).is_absolute() {
        return Err(AgentError::new("subfolder must be relative"));
    }
    let mut out = PathBuf::new();
    for part in text.split(['\\', '/']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(AgentError::new("subfolder cannot escape the destination"));
        }
        out.push(part);
    }
    Ok(out)
}

fn walk_files(root: &Path, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_EXPORT_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_EXPORT_FILES {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if IGNORED_MARKERS.contains(&name.as_str()) {
            continue;
        }
        let full = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            walk_files(&full, out);
        } else if kind.is_file() {
            out.push(full);
        }
    }
}

fn collect_sources(asset: &Asset) -> Vec<(PathBuf, String)> {
    let importables: Vec<(PathBuf, String)> = asset
        .importables
        .iter()
        .filter(|item| !item.path.is_empty() && Path::new(&item.path).is_file())
        .map(|item| {
            let rel = if item.rel.is_empty() {
                Path::new(&item.path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            } else {
                item.rel.clone()
            };
            (PathBuf::from(&item.path), rel)
        })
        .collect();
    if !importables.is_empty() {
        return importables;
    }

    let folder = PathBuf::from(&asset.folder);
    let mut files = Vec::new();
    walk_files(&folder, &mut files);
    files
        .into_iter()
        .map(|full| {
            let rel = full
                .strip_prefix(&folder)
                .map(paths::to_forward_slashes)
                .unwrap_or_default();
            (full, rel)
        })
        .collect()
}

fn asset_summary(asset: &Asset, library: &LibraryScan) -> Value {
    json!({
        "assetId": asset.id,
        "name": asset.name,
        "libraryId": asset.library_id,
        "libraryName": library.name,
        "kind": asset.kind,
        "kinds": asset.kinds,
        "tags": asset.tags,
        "importable": asset.importable,
        "fileCount": asset.file_count,
        "sizeBytes": asset.size_bytes,
        "folder": asset.folder,
        "description": asset.description,
    })
}

fn matches_query(asset: &Asset, query: Option<&str>) -> bool {
    let Some(query) = query.filter(|q| !q.is_empty()) else {
        return true;
    };
    let needle = query.to_lowercase();
    let mut haystack = vec![
        asset.name.clone(),
        asset.category.clone(),
        asset.rel_path.clone(),
        asset.kind.clone(),
        asset.description.clone(),
    ];
    haystack.extend(asset.kinds.iter().cloned());
    haystack.extend(asset.tags.iter().cloned());
    haystack.join(" ").to_lowercase().contains(&needle)
}

fn arg_str<'a>(args: &'a Value, name: &str) -> Option<&'a str> {
    args.get(name).and_then(Value::as_str).map(str::trim)
}

pub fn resolve_asset<'a>(
    libraries: &'a [LibraryScan],
    args: &Value,
) -> Result<(&'a Asset, &'a LibraryScan), AgentError> {
    let library_id = arg_str(args, "libraryId").filter(|s| !s.is_empty());
    let scoped: Vec<(&Asset, &LibraryScan)> = libraries
        .iter()
        .filter(|lib| library_id.map(|id| lib.id == id).unwrap_or(true))
        .flat_map(|lib| lib.assets.iter().map(move |asset| (asset, lib)))
        .collect();

    if scoped.is_empty() {
        if library_id.is_some() {
            return Err(AgentError::coded("unknown libraryId", "not_found"));
        }
        return Err(AgentError::coded(
            "no assets indexed yet - add a library in Poly Vault",
            "not_found",
        ));
    }

    if let Some(id) = arg_str(args, "assetId").filter(|s| !s.is_empty()) {
        return scoped
            .iter()
            .find(|(asset, _)| asset.id == id)
            .map(|(asset, lib)| (*asset, *lib))
            .ok_or_else(|| AgentError::coded(format!("unknown assetId: {id}"), "not_found"));
    }

    let Some(name) = arg_str(args, "name").filter(|s| !s.is_empty()) else {
        return Err(AgentError::new("provide assetId or name"));
    };
    let needle = name.to_lowercase();
    let exact: Vec<&(&Asset, &LibraryScan)> = scoped
        .iter()
        .filter(|(asset, _)| asset.name.to_lowercase() == needle)
        .collect();
    if exact.len() == 1 {
        return Ok((exact[0].0, exact[0].1));
    }
    if exact.len() > 1 {
        let ids: Vec<&str> = exact.iter().map(|(asset, _)| asset.id.as_str()).collect();
        return Err(AgentError::coded(
            format!(
                "asset name \"{name}\" is ambiguous - pass assetId or libraryId (matches: {})",
                ids.join(", ")
            ),
            "ambiguous",
        ));
    }

    let partial: Vec<&(&Asset, &LibraryScan)> = scoped
        .iter()
        .filter(|(asset, _)| asset.name.to_lowercase().contains(&needle))
        .collect();
    if partial.len() == 1 {
        return Ok((partial[0].0, partial[0].1));
    }
    if partial.len() > 1 {
        let matches: Vec<String> = partial
            .iter()
            .take(5)
            .map(|(asset, _)| format!("{} [{}]", asset.name, asset.id))
            .collect();
        return Err(AgentError::coded(
            format!(
                "no exact asset named \"{name}\" - narrow it down (matches: {})",
                matches.join(", ")
            ),
            "ambiguous",
        ));
    }
    Err(AgentError::coded(
        format!("no asset found for \"{name}\""),
        "not_found",
    ))
}

fn clamp_limit(args: &Value) -> usize {
    let n = args.get("limit").and_then(Value::as_u64).unwrap_or(0) as usize;
    if n == 0 {
        return DEFAULT_LIMIT;
    }
    n.min(MAX_LIMIT)
}

fn tool_result(payload: Value) -> Value {
    let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".into());
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": payload,
    })
}

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

pub fn tools_json() -> Vec<Value> {
    vec![
        json!({
            "name": "poly_vault_list_libraries",
            "description": "List the asset libraries registered in Poly Vault, with asset counts and filesystem roots.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "poly_vault_search_assets",
            "description": "Search indexed assets by free text (name, category, tags, description). Returns compact asset summaries.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Free-text query. Omit to list assets." },
                    "libraryId": { "type": "string" },
                    "kind": { "type": "string", "description": "mesh, texture, audio, unitypackage, ..." },
                    "tag": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "poly_vault_get_asset",
            "description": "Get one asset by assetId or exact name: description, tags, importable files and preview path.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "assetId": { "type": "string" },
                    "name": { "type": "string" },
                    "libraryId": { "type": "string" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "poly_vault_export_asset",
            "description": "Copy an asset into a project folder on disk. Importable files are copied; assets without importables copy their folder contents. Refuses destinations inside a Poly Vault library or a system folder.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "assetId": { "type": "string" },
                    "name": { "type": "string" },
                    "libraryId": { "type": "string" },
                    "destination": { "type": "string", "description": "Absolute path of the project folder to copy into." },
                    "subfolder": { "type": "string", "description": "Relative subfolder under destination (e.g. \"Assets/ThirdParty\")." },
                    "flatten": { "type": "boolean", "description": "Copy files directly into destination instead of destination/<asset name>." },
                    "overwrite": { "type": "boolean", "description": "Replace files that already exist." }
                },
                "required": ["destination"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "poly_vault_list_exports",
            "description": "List recent agent exports recorded by Poly Vault.",
            "inputSchema": {
                "type": "object",
                "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 50 } },
                "additionalProperties": false
            }
        }),
    ]
}

fn touch(
    sessions: &Mutex<HashMap<String, AgentSession>>,
    session_id: Option<&str>,
    client: Option<&Value>,
    tool: Option<&str>,
) -> String {
    let mut all = sessions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let mut id = session_id.map(str::to_string);
    if id.as_deref().map(|s| all.contains_key(s)).unwrap_or(false) == false {
        if id.is_none() && client.is_none() && !all.is_empty() {
            let recent = all
                .values()
                .max_by_key(|s| s.last_seen_at)
                .map(|s| s.id.clone());
            id = recent;
        }
    }
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let at = now_ms();

    let entry = all.entry(id.clone()).or_insert_with(|| AgentSession {
        id: id.clone(),
        name: client
            .and_then(|c| c.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("Unknown agent")
            .to_string(),
        version: client
            .and_then(|c| c.get("version"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        connected_at: at,
        last_seen_at: at,
        calls: 0,
        last_tool: String::new(),
        tools: HashMap::new(),
    });

    entry.last_seen_at = at;
    if let Some(name) = client.and_then(|c| c.get("name")).and_then(Value::as_str) {
        entry.name = name.to_string();
    }
    if let Some(version) = client
        .and_then(|c| c.get("version"))
        .and_then(Value::as_str)
    {
        entry.version = version.to_string();
    }
    if let Some(tool) = tool.filter(|t| !t.is_empty()) {
        entry.calls += 1;
        entry.last_tool = tool.to_string();
        *entry.tools.entry(tool.to_string()).or_insert(0) += 1;
    }
    id
}

fn export_asset(
    state: &AppState,
    args: &Value,
    session: Option<&AgentSession>,
) -> Result<Value, AgentError> {
    let libraries = state.scan_libraries();
    let (asset, library) = resolve_asset(&libraries, args)?;
    let destination = assert_destination(args.get("destination"), &state.library_paths())?;
    let subfolder = sanitize_subfolder(args.get("subfolder"))?;
    let root = destination.join(&subfolder);
    let flatten = args.get("flatten").and_then(Value::as_bool).unwrap_or(false);
    let overwrite = args.get("overwrite").and_then(Value::as_bool).unwrap_or(false);

    if !asset.folder.is_empty() && within_text(&root, Path::new(&asset.folder)) {
        return Err(AgentError::new(
            "destination cannot be the asset folder itself or inside it",
        ));
    }
    fs::create_dir_all(&root).map_err(|e| AgentError::new(format!("cannot create destination: {e}")))?;

    let sources = collect_sources(asset);
    let mut files: Vec<String> = Vec::new();
    let mut skipped_files: Vec<String> = Vec::new();
    let mut copied = 0usize;
    let mut skipped = 0usize;
    let mut bytes: u64 = 0;
    let mut seen_targets = std::collections::HashSet::new();

    for (source, rel) in sources {
        if copied + skipped >= MAX_EXPORT_FILES {
            break;
        }
        if !source.is_file() {
            skipped += 1;
            continue;
        }
        let rel_part = if flatten {
            source
                .file_name()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("file"))
        } else {
            Path::new(&asset.name).join(if rel.is_empty() {
                source
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            } else {
                rel.clone()
            })
        };
        let target = root.join(rel_part);
        if !within_text(&target, &root) {
            skipped += 1;
            continue;
        }
        let target_key = norm(&target);
        if !seen_targets.insert(target_key) {
            skipped += 1;
            continue;
        }
        if target.exists() && !overwrite {
            skipped += 1;
            skipped_files.push(paths::key(&target));
            continue;
        }
        if let Some(parent) = target.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::copy(&source, &target).is_err() {
            skipped += 1;
            continue;
        }
        let size = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
        bytes += size;
        if bytes > MAX_COPY_BYTES {
            return Err(AgentError::new("export exceeds the 2 GB safety limit"));
        }
        files.push(paths::key(&target));
        copied += 1;
    }

    let record = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "assetId": asset.id,
        "assetName": asset.name,
        "libraryId": library.id,
        "libraryName": library.name,
        "destination": paths::key(&root),
        "fileCount": files.len(),
        "copied": copied,
        "skipped": skipped,
        "bytes": bytes,
        "flatten": flatten,
        "status": if copied > 0 { "done" } else { "skipped" },
        "files": files.iter().take(MAX_RECORDED_FILES).cloned().collect::<Vec<String>>(),
        "skippedFiles": skipped_files.iter().take(MAX_RECORDED_FILES).cloned().collect::<Vec<String>>(),
        "createdAt": now_iso(),
        "agent": session.map(|s| json!({ "name": s.name, "version": s.version })),
    });
    state.add_export(record.clone());

    let mut out = record;
    out["asset"] = asset_summary(asset, library);
    out["hint"] = json!(if copied > 0 {
        format!("Copied {copied} file(s) into {}", paths::key(&root))
    } else {
        "Nothing copied - every target file already exists (pass overwrite: true to replace)."
            .to_string()
    });
    Ok(out)
}

fn call_tool(state: &AppState, name: &str, args: &Value, session: &AgentSession) -> Result<Value, AgentError> {
    match name {
        "poly_vault_list_libraries" => {
            let libraries: Vec<Value> = state
                .scan_libraries()
                .iter()
                .map(|lib| {
                    json!({
                        "libraryId": lib.id,
                        "name": lib.name,
                        "path": lib.path,
                        "assetCount": lib.assets.len(),
                        "fileCount": lib.file_count,
                    })
                })
                .collect();
            Ok(json!({ "libraries": libraries }))
        }

        "poly_vault_search_assets" => {
            let limit = clamp_limit(args);
            let kind = arg_str(args, "kind").map(str::to_lowercase);
            let tag = arg_str(args, "tag").map(str::to_lowercase);
            let library_id = arg_str(args, "libraryId");
            let query = arg_str(args, "query");
            let mut hits = Vec::new();
            for lib in state.scan_libraries() {
                if let Some(id) = library_id.filter(|s| !s.is_empty()) {
                    if lib.id != id {
                        continue;
                    }
                }
                for asset in &lib.assets {
                    if let Some(kind) = &kind {
                        if &asset.kind != kind && !asset.kinds.iter().any(|k| k == kind) {
                            continue;
                        }
                    }
                    if let Some(tag) = &tag {
                        if !asset.tags.iter().any(|t| &t.to_lowercase() == tag) {
                            continue;
                        }
                    }
                    if !matches_query(asset, query) {
                        continue;
                    }
                    hits.push(asset_summary(asset, &lib));
                }
            }
            let total = hits.len();
            Ok(json!({
                "total": total,
                "returned": hits.into_iter().take(limit).collect::<Vec<Value>>(),
                "query": query.unwrap_or(""),
            }))
        }

        "poly_vault_get_asset" => {
            let libraries = state.scan_libraries();
            let (asset, library) = resolve_asset(&libraries, args)?;
            let mut out = asset_summary(asset, library);
            out["category"] = json!(asset.category);
            out["created"] = json!(asset.created);
            out["updated"] = json!(asset.updated);
            out["preview"] = asset
                .preview
                .as_ref()
                .map(|p| json!({ "path": p.path, "rel": p.rel }))
                .unwrap_or(Value::Null);
            out["importables"] = json!(asset
                .importables
                .iter()
                .map(|item| json!({
                    "name": item.name,
                    "rel": item.rel,
                    "kind": item.kind,
                    "path": item.path,
                }))
                .collect::<Vec<Value>>());
            Ok(out)
        }

        "poly_vault_export_asset" => export_asset(state, args, Some(session)),

        "poly_vault_list_exports" => {
            let limit = clamp_limit(args);
            let mut exports = state.exports_list();
            exports.reverse();
            Ok(json!({
                "exports": exports.into_iter().take(limit).collect::<Vec<Value>>(),
            }))
        }

        _ => Err(AgentError::coded(
            format!("unknown tool: {name}"),
            "method_not_found",
        )),
    }
}

pub fn snapshot(state: &AppState) -> Value {
    let at = now_ms();
    let mut agents: Vec<Value> = {
        let sessions = state
            .agents
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sessions
            .values()
            .map(|session| {
                json!({
                    "id": session.id,
                    "name": session.name,
                    "version": session.version,
                    "connectedAt": session.connected_at,
                    "lastSeenAt": session.last_seen_at,
                    "calls": session.calls,
                    "lastTool": session.last_tool,
                    "tools": session.tools,
                    "connected": at - session.last_seen_at < AGENT_TTL_MS,
                })
            })
            .collect()
    };
    agents.sort_by(|a, b| b["lastSeenAt"].as_i64().cmp(&a["lastSeenAt"].as_i64()));
    agents.truncate(20);

    let mut exports = state.exports_list();
    exports.reverse();
    exports.truncate(25);

    json!({
        "agents": agents,
        "exports": exports,
        "mcp": {
            "url": format!("http://{}:{}/mcp", state.bridge_host, state.bridge_port),
            "protocolVersion": PROTOCOL_VERSION,
            "tools": tools_json().len(),
        },
    })
}

fn handle_message(
    state: &AppState,
    message: &Value,
    session_header: Option<&str>,
) -> (Option<Value>, Option<String>) {
    let Some(object) = message.as_object() else {
        return (
            Some(rpc_error(&Value::Null, -32600, "invalid request")),
            session_header.map(str::to_string),
        );
    };
    let has_id = object.contains_key("id");
    let id = object.get("id").cloned().unwrap_or(Value::Null);

    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || object.get("method").and_then(Value::as_str).is_none()
    {
        return (
            Some(rpc_error(&id, -32600, "invalid request")),
            session_header.map(str::to_string),
        );
    }
    let method = object.get("method").and_then(Value::as_str).unwrap_or("");
    let params = object.get("params").cloned().unwrap_or(json!({}));

    if method == "initialize" {
        let session_id = touch(
            &state.agents,
            session_header,
            params.get("clientInfo"),
            Some("initialize"),
        );
        let payload = rpc_result(
            &id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "poly-vault", "version": state.version },
                "instructions": "Poly Vault indexes local 3D/2D asset libraries. Search, inspect, then export assets into the project folder you are working in.",
            }),
        );
        return (Some(payload), Some(session_id));
    }

    if method == "ping" {
        return (
            has_id.then(|| rpc_result(&id, json!({}))),
            session_header.map(str::to_string),
        );
    }

    if method.starts_with("notifications/") || !has_id {
        if method.starts_with("notifications/") {
            let session_id = touch(&state.agents, session_header, None, None);
            return (None, Some(session_id));
        }
        return (None, session_header.map(str::to_string));
    }

    if method == "tools/list" {
        let session_id = touch(&state.agents, session_header, None, None);
        return (
            Some(rpc_result(&id, json!({ "tools": tools_json() }))),
            Some(session_id),
        );
    }

    if method == "tools/call" {
        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
        let session_id = touch(&state.agents, session_header, None, Some(name));
        let session = {
            let sessions = state
                .agents
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            sessions.get(&session_id).cloned()
        };
        let args = params.get("arguments").cloned().unwrap_or(json!({}));
        let result = match session {
            Some(session) => call_tool(state, name, &args, &session),
            None => Err(AgentError::new("agent session lost")),
        };
        let payload = match result {
            Ok(value) => rpc_result(&id, tool_result(value)),
            Err(err) => rpc_result(
                &id,
                json!({
                    "content": [{ "type": "text", "text": err.message }],
                    "isError": true,
                }),
            ),
        };
        return (Some(payload), Some(session_id));
    }

    if method == "resources/list" {
        return (
            Some(rpc_result(&id, json!({ "resources": [] }))),
            session_header.map(str::to_string),
        );
    }

    if method == "prompts/list" {
        return (
            Some(rpc_result(&id, json!({ "prompts": [] }))),
            session_header.map(str::to_string),
        );
    }

    (
        Some(rpc_error(&id, -32601, format!("method not found: {method}"))),
        session_header.map(str::to_string),
    )
}

pub fn handle_rpc(
    state: &AppState,
    body: &Value,
    session_header: Option<&str>,
) -> (Option<Value>, Option<String>) {
    if let Some(messages) = body.as_array() {
        let mut replies = Vec::new();
        let mut session: Option<String> = session_header.map(str::to_string);
        for message in messages {
            let (payload, next) = handle_message(state, message, session.as_deref());
            if next.is_some() {
                session = next;
            }
            if let Some(payload) = payload {
                replies.push(payload);
            }
        }
        let payload = if replies.is_empty() {
            None
        } else {
            Some(Value::Array(replies))
        };
        return (payload, session);
    }
    handle_message(state, body, session_header)
}

pub fn close_session(state: &AppState, session_id: Option<&str>) {
    let Some(id) = session_id else { return };
    state
        .agents
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, std::sync::Arc<AppState>) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Lib");
        let chair = root.join("3d/Chair");
        fs::create_dir_all(&chair).unwrap();
        fs::write(chair.join("chair.fbx"), b"fake-fbx").unwrap();
        fs::write(chair.join("preview.png"), b"fake-png").unwrap();

        let state = std::sync::Arc::new(AppState::new(dir.path().join("data")));
        state.add_library(&root.to_string_lossy());
        (dir, state)
    }

    fn export_dir(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("project")
    }

    #[test]
    fn refuses_libraries_system_folders_and_relative_paths() {
        let (dir, state) = fixture();
        let between = dir.path().join("project");
        let libs = state.library_paths();
        let ok = assert_destination(Some(&json!(between.to_string_lossy())), &libs);
        assert!(ok.is_ok());

        let inside_lib = assert_destination(
            Some(&json!(dir.path().join("Lib/3d").to_string_lossy())),
            &libs,
        );
        assert!(inside_lib.is_err());

        assert!(assert_destination(Some(&json!("relative/path")), &libs).is_err());
        assert!(assert_destination(None, &libs).is_err());
    }

    #[test]
    fn subfolder_cannot_escape_destination() {
        assert_eq!(
            sanitize_subfolder(Some(&json!("Assets/ThirdParty"))).unwrap(),
            PathBuf::from("Assets").join("ThirdParty")
        );
        assert!(sanitize_subfolder(Some(&json!("../escape"))).is_err());
        assert!(sanitize_subfolder(Some(&json!("/abs"))).is_err());
        assert_eq!(sanitize_subfolder(None).unwrap(), PathBuf::new());
    }

    #[tokio::test]
    async fn exports_assets_and_reports_sessions() {
        let (dir, state) = fixture();
        let (init, session) = handle_rpc(
            &state,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientInfo": { "name": "rust-agent", "version": "1.0.0" },
                    "capabilities": {}
                }
            }),
            None,
        );
        assert_eq!(init.unwrap()["result"]["serverInfo"]["name"], "poly-vault");
        let session = session.unwrap();

        let (list, _) = handle_rpc(
            &state,
            &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            Some(&session),
        );
        let tools = list.unwrap()["result"]["tools"].as_array().unwrap().len();
        assert_eq!(tools, 5);

        let target = export_dir(&dir);
        let (export, _) = handle_rpc(
            &state,
            &json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "poly_vault_export_asset",
                    "arguments": { "name": "Chair", "destination": target.to_string_lossy() }
                }
            }),
            Some(&session),
        );
        let export = export.unwrap();
        assert!(export["result"]["isError"].is_null());
        assert_eq!(export["result"]["structuredContent"]["copied"], 1);
        assert!(target.join("Chair").join("chair.fbx").is_file());

        let snap = snapshot(&state);
        assert_eq!(snap["agents"].as_array().unwrap().len(), 1);
        assert_eq!(snap["agents"][0]["name"], "rust-agent");
        assert_eq!(snap["agents"][0]["connected"], true);
        assert_eq!(snap["exports"].as_array().unwrap().len(), 1);
        assert_eq!(snap["exports"][0]["assetName"], "Chair");
        assert!(snap["mcp"]["url"].as_str().unwrap().ends_with("/mcp"));

        let (blocked, _) = handle_rpc(
            &state,
            &json!({
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
            }),
            Some(&session),
        );
        assert_eq!(blocked.unwrap()["result"]["isError"], true);
    }
}
