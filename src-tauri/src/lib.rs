mod autotags;
mod bridge;
mod commands;
mod enrichment;
mod library;
mod paths;
mod state;
mod store;
mod time;
mod unity_store;

use std::sync::Arc;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub fn run() {
    let user_data = state::user_data_dir();
    state::migrate_user_data(&user_data);
    let app_state = Arc::new(state::AppState::new(user_data));

    if let Ok(boot) = std::env::var("ASSETVAULT_BOOT_LIBRARY") {
        if !boot.is_empty() {
            app_state.add_library(&boot);
        }
    }

    let bridge_state = Arc::clone(&app_state);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::add_library,
            commands::remove_library,
            commands::get_state,
            commands::get_server_info,
            commands::open_path,
            commands::fetch_unity_description,
        ])
        .setup(move |app| {
            tauri::async_runtime::spawn(async move {
                if let Err(err) = bridge::serve(bridge_state).await {
                    eprintln!("[Poly Vault] bridge failed: {err}");
                }
            });

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Poly Vault")
                .inner_size(1280.0, 820.0)
                .min_inner_size(960.0, 600.0)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Poly Vault");
}
