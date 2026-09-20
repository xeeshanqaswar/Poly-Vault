# Poly Vault

**Your personal 3D & 2D asset library — with a one-click pipeline into Unity 6.**

<p>
  <a href="https://github.com/xeeshanqaswar/Poly-Vault"><img src="https://img.shields.io/badge/project-Poly%20Vault-1f6feb" alt="Project"></a>
  <a href="https://github.com/xeeshanqaswar/Poly-Vault/releases"><img src="https://img.shields.io/badge/version-0.3.0-1f6feb" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-brightgreen" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-793700" alt="Platforms">
  <a href="https://github.com/xeeshanqaswar/Poly-Vault/actions"><img src="https://img.shields.io/badge/CI-GitHub%20Actions-2b7489" alt="CI"></a>
  <img src="https://img.shields.io/badge/tests-smoke%20%2B%20e2e-passing-brightgreen" alt="Tests">
  <a href="https://github.com/xeeshanqaswar/Poly-Vault/issues"><img src="https://img.shields.io/badge/help-issues-yellow" alt="Issues"></a>
</p>

Poly Vault turns any folder on your computer into a beautiful, browsable asset
library. Preview your models and textures, tag and describe them, search them,
and send them straight into your Unity project — all offline, all on your
machine. **No cloud, no accounts, no tracking.**

Built by **Zeeshan Qaswar**.

---

## Table of contents

- [Highlights](#highlights)
- [Quick start](#quick-start)
- [How the app works](#how-the-app-works)
- [Folder layout convention](#folder-layout-convention)
- [Importing into Unity (Unity 6)](#importing-into-unity-unity-6)
- [Data & privacy](#data--privacy)
- [Power-user controls](#power-user-controls)
- [Development](#development)
- [Packaging for release](#packaging-for-release)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License](#license)

---

## Highlights

- **Browse everything** — libraries, nested folders, and every asset as a
  preview card, with a tree on the left and thumbnails in the middle.
- **Search & filter** — full-text-ish search across the current view and a
  toolbar **Tags** dropdown that AND-filters cards by tag, with live chips and
  an active-filter badge.
- **Understand your library** — every folder shows total assets, files, size,
  and what it contains (meshes, textures, audio, video, fonts, materials,
  scripts…).
- **Describe & organise** — add tags and descriptions to any folder, stored
  locally and searchable.
- **One-click Unity import** — queue any asset; the bundled Unity 6 Editor
  plugin copies it into `Assets/PolyVaultImports/…`. `.unitypackage` files open
  Unity's import dialog, everything else is copied automatically.
- **Live Unity connection indicator** — the toolbar shows *unity: connected*
  as long as the Editor plugin is actively talking to the bridge.
- **Make it yours** — 3 themes (Default / Dark / Light), offline-bundled
  Montserrat font, resizable side panels, and a clean, menu-bar-free,
  macOS-inspired window (no File/Edit/View menu — everything is in the UI).
- **Truly local** — everything is stored in JSON on your machine; the bridge
  binds to `127.0.0.1` and serves no secrets.

> **New in 0.3** — the app is now called **Poly Vault** (it was "Asset Vault").
> Your existing libraries, tags, and descriptions are carried over
> automatically on first launch.

---

## Quick start

### Option A — installers (recommended)

| Platform | Get it | Install |
| --- | --- | --- |
| **Windows** | `dist/PolyVault-Setup-0.3.0.exe` | Run the NSIS installer. |
| **Linux** | `dist/PolyVault-0.3.0-x86_64.AppImage` or `PolyVault-0.3.0-amd64.deb` | AppImage: `chmod +x` then run. Deb: `sudo dpkg -i`. |
| **macOS** | build from source or grab the GitHub Actions artifacts (the DMG must be produced on a Mac) | Open the DMG, drag to Applications. |

The Windows exe is **unsigned**, so SmartScreen may ask for *More info →
Run anyway* the first time. On macOS, first launch may need
*System Settings → Privacy & Security → Open Anyway*. See
[Packaging & signing](docs/TECHNICAL.md#packaging--signing) for signed builds.

### Option B — run from source

Requirements: [Node.js](https://nodejs.org) 20+ (tested on 24 LTS).

```powershell
npm install
npm start
```

---

## How the app works

1. **Add a library** — pick any folder that contains *category subfolders*.
2. The app scans it (filesystem only, nothing leaves your machine) and shows it
   as a **tree on the left** and **preview cards in the middle**.
3. Click any **folder or card** → the **details panel on the right** shows
   dates, counts, sizes, detected asset types, tags, and a description editor.
4. Anything importable gets an **Import to Unity** button. If the Unity Editor
   plugin is running, the asset lands in
   `Assets/PolyVaultImports/<Library>/<Category>/<Asset>/…`, always as a
   **copy** — your library is never modified.

Card selection is flicker-free (only the highlight and details update), 
rescans skip repainting when nothing changed, and resizing the three-pane
layout is pointer-driven with the widths remembered between runs.

## Folder layout convention

Folders can nest as deep as you like. A folder becomes an **asset** when a
preview image or an importable file sits **directly** inside it; anything else
is a **folder** used for organisation.

```
MyLibrary                    ← the folder you "Add Library"
├── 3d
│   ├── Props
│   │   └── Furniture
│   │       ├── Chair
│   │       │   ├── preview.png      ← card thumbnail
│   │       │   ├── chair.fbx        ← importable → Import buttons
│   │       │   └── readme.txt       ← ignored (not importable)
│   │       └── StoneVase
│   │           └── preview.webp     ← browse-only (nothing importable)
├── 2d
│   └── GrassTile
│       ├── preview.jpg              ← card thumbnail
│       └── grass.png                ← imported as a texture
```

The rules that decide what shows up:

- **Asset** = a folder that directly contains a preview image
  (`preview.png/jpg/jpeg/webp/gif`) **or** an importable file. Folders that
  only contain other folders are **folder** (container) nodes in the tree.
- The **preview image is never imported** — a folder with only a `preview.png`
  is browse-only.
- **Importable extensions** — Unity packages, meshes/models
  (`.fbx .obj .glb .gltf .blend .dae .3ds .dxf .stl …`), textures, fonts,
  audio, video, animation, materials, and scripts. See the
  [specification](docs/SPECIFICATION.md#importable-file-kinds) for the full
  list.
- Drop an empty **`.assetvault-ignore`** (or `.nomedia`) file into any folder
  to skip it (and its whole subtree).

---

## Importing into Unity (Unity 6)

Install the bundled Editor package once per project:

```powershell
# from this repo
Copy-Item -Recurse unity-plugin/PolyVault <yourProject>/Packages/PolyVault
```

…or in Unity: **Window → Package Manager → `+` → Add package from disk**, then
pick `unity-plugin/PolyVault/package.json`.

Then open **Window → Poly Vault → Poly Vault** and you'll get:

- **Server URL** — `http://127.0.0.1:7100` (must match the desktop app).
- **Sync in background** — polls the app on an interval while Unity is open.
- **Auto-import safe jobs** — imports everything except `.unitypackage`
  (those open Unity's interactive import dialog).
- **Import now** — manual, always-interactive import per job.

Jobs you queue from the desktop app are picked up here, marked **processing**,
imported, and reported back — the desktop app's job badge updates within
seconds. Files are **copies**; nothing is ever moved or deleted from your
library. Tags are written alongside each import as `polyvault.tags.json`.

---

## Data & privacy

Everything is stored **locally** in the app data folder
(`%APPDATA%\Poly Vault` on Windows, `~/.config/Poly Vault` on Linux,
`~/Library/Application Support/Poly Vault` on macOS):

| File | Contents |
| --- | --- |
| `asset-vault-settings.json` | Registered libraries + server settings |
| `asset-vault-tags.json` | Tags per folder |
| `asset-vault-meta.json` | Descriptions per folder |
| `asset-vault-jobs.json` | Import job history |

- The app is **offline-first**: no telemetry, no accounts, no cloud sync.
- The local bridge binds to `127.0.0.1` only; no payload is ever served to
  other hosts.
- Pre-0.3 data under a legacy `…/Asset Vault` folder is migrated
  automatically.

---

## Power-user controls

The bridge and data folders can be redirected — handy for scripting, backups,
and the test suite:

| Variable | Effect |
| --- | --- |
| `ASSETVAULT_USER_DATA` | Redirect the user-data folder (headless/test isolation) |
| `ASSETVAULT_BOOT_LIBRARY` | Register a library at boot without the folder dialog |
| `ASSETVAULT_DEBUG` | Stream renderer console messages to stdout |

The bridge port/host can also be changed in `asset-vault-settings.json`
(`server` object); the Unity plugin's Server URL must then match.

---

## Development

```powershell
npm run smoke   # headless scanner + bridge test (no Electron window)
npm run e2e     # boots the real app with a fixture library and checks the UI
npm start       # run the app (dev)
npm run icons   # regenerate icons / logo / bundled fonts (only after artwork changes)
```

See [docs/TECHNICAL.md](docs/TECHNICAL.md) for the full developer guide:
architecture, IPC, data model, scanner, HTTP API reference, job lifecycle,
storage & migration, security model, packaging internals, and test harness.

## Packaging for release

```powershell
npm run pack          # unpacked dev build → dist/win-unpacked
npm run dist          # Windows NSIS installer → dist/PolyVault-Setup-<ver>.exe
npm run dist:linux    # Linux AppImage + .deb → dist/
npm run dist:mac      # macOS DMG + zip → dist/  (requires a Mac)
```

> **One-command cross-platform builds:** the bundled
> [GitHub Actions workflow](.github/workflows/build.yml) builds Windows, Linux,
> and macOS installers on every `v*` tag and uploads them as workflow
> artifacts — push a tag, grab `dist/*` from the Actions tab.

The Windows `exe` is unsigned by default (SmartScreen prompt);
`docs/TECHNICAL.md#packaging--signing` covers code-signing and macOS
notarisation. AppImage/deb and DMG builds must match the host OS (or use the
CI workflow).

---

## Documentation

| Doc | What it covers |
| --- | --- |
| [docs/SPECIFICATION.md](docs/SPECIFICATION.md) | Product & technical specification: every capability, functional requirements, API contracts, and edge-case behaviour |
| [docs/TECHNICAL.md](docs/TECHNICAL.md) | Developer guide: architecture, internals, storage, security, packaging, test harness |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to report bugs and submit changes |

---

## Contributing

Contributions are welcome — bug reports, fixes, and feature ideas. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) first; the important bits: run the smoke and
e2e tests, keep changes scoped, and match the existing code style.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full release history.

## License

[MIT](LICENSE) © Zeeshan Qaswar. Unity support is provided by the bundled **Poly Vault** Editor package under `unity-plugin/PolyVault`.