# Reddit post

---

**Title:**

I built a free, offline-first asset manager that ships your 3D/2D assets into
Unity with one click — open source, MIT

**Body:**

Hey r/Unity3D (and gamedev folks!), I've been living the "thousands of asset
folders across multiple drives" life and finally built the tool I wanted:
**Poly Vault**.

No cloud, no accounts — it's a desktop app that turns any folder into a
searchable library:

- Folder tree + preview-card grid for everything (meshes, textures, audio,
  materials, fonts, scripts…)
- Per-folder tags & descriptions, tag filtering (AND), and search
- Per-folder stats: asset counts, file counts, sizes, and detected asset kinds
- **One-click import into Unity 6**: queue a job in the app, and the bundled
  Unity Editor package (UPM plugin, Unity 6) copies it into
  `Assets/PolyVaultImports/…` — copies only, your library is never modified or
  deleted
- `preview.png` thumbnails, `.assetvault-ignore` markers to hide folders

Plus some quality-of-life stuff: 3 themes, live "Unity connected" indicator in
the UI, resizable panes, and it's fully offline-first (loopback-only local
server, no telemetry).

Built with Electron, no front-end framework, JSON storage, MIT licensed.

Installers for **Windows, Linux, and macOS** + the Unity package for v0.3.0:
https://github.com/xeeshanqaswar/Poly-Vault/releases

Repo: https://github.com/xeeshanqaswar/Poly-Vault

Would love feedback — especially from people who have big organic libraries
(non-DCC-named folders) and want a nicer way to browse them. What would you
want added next (ratings, drag-and-drop into scenes, folder watching, format
conversion…)?

---