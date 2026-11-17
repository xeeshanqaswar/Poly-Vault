'use strict';

// Tauri bootstrap for the shared renderer.
// The Electron build exposes `assetVault` through the preload script; the Rust
// build injects this file before renderer.js and maps the same surface onto
// Tauri commands. No-op when running inside Electron.
(function () {
  if (window.assetVault || !window.__TAURI__ || !window.__TAURI__.core) return;

  const invoke = window.__TAURI__.core.invoke;

  window.assetVault = {
    addLibrary: () => invoke('add_library'),
    removeLibrary: (id) => invoke('remove_library', { id }),
    getState: () => invoke('get_state'),
    getServerInfo: () => invoke('get_server_info'),
    openInExplorer: (targetPath) => invoke('open_path', { targetPath }),
    fetchUnityDescription: (name) => invoke('fetch_unity_description', { name }),
  };
})();
