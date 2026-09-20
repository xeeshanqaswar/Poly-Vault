# Poly Vault — Technical Guide

Developer-facing documentation for the **Poly Vault** desktop application and
its Unity 6 bridge. Product: *Poly Vault* · Author: **Zeeshan Qaswar**.

> For the *product* spec — full capability catalog, functional behaviour, API
> contracts, and data shapes — see
> [SPECIFICATION.md](SPECIFICATION.md). This guide covers *how it is built*.

Contents:

- [Architecture](#architecture)
- [Processes & IPC](#processes--ipc)
- [Library data model](#library-data-model)
- [The scanner](#the-scanner)
- [Bridge HTTP API](#bridge-http-api)
- [Import job lifecycle](#import-job-lifecycle)
- [Renderer & UI state](#renderer--ui-state)
- [Theming & layout](#theming--layout)
- [Storage & migration](#storage--migration)
- [Security model](#security-model)
- [Packaging & signing](#packaging--signing)
- [Test harness](#test-harness)
- [Environment hooks](#environment-hooks)
- [Roadmap](#roadmap)

---

## Architecture

```
 Electron main (Node)                     Renderer (Chromium)
 ┌───────────────────────────┐            ┌──────────────────────────┐
 │ src/main/index.js         │  IPC       │ ui/index.html            │
 │   window + dialogs        │◄──────────►│ ui/renderer.js (SPA)     │
 │   stores (JsonStore)      │            └──────────┬───────────────┘
 │   user-data migration     │                       │ fetch (127.0.0.1)
 │ src/main/bridgeServer.js  │ ◄─────────────────────┘
 │   HTTP/1.1 bridge :7100   │        Unity Editor (plugin)
 │   job queue (in-memory)   │ ◄────────────────────────
 └───────────────────────────┘  GET  /api/unity/import-jobs
                                POST /api/unity/import-jobs/{id}/complete
```

- The main process owns all state and persistence.
- The renderer is a plain `<script>` SPA (no framework) talking to the bridge.
- The **bridge** is the single HTTP surface: it serves the UI **and** the
  Unity plugin. It is bound to `127.0.0.1` by default (override via
  `asset-vault-settings.json` → `server`).
- The Unity Editor package polls the bridge; the desktop app never pushes.

### Repository layout

```
src/main/store.js          JSON-backed persistence (no Electron deps)
src/main/library.js        scanner: asset/folder detection, aggregation
src/main/bridgeServer.js   HTTP bridge + job queue (exported pure for tests)
src/main/index.js          Electron main, IPC, dialogs, migration
src/preload.js             context-isolated renderer bridge (IPC)
ui/                        renderer (index.html / style.css / renderer.js)
tests/smoke.js             headless scanner + bridge integration test
tests/e2e.js               full-process Electron test with a fixture library
tools/gen-icon.js          programmatic icon generation (ico / png / icns)
tools/gen-sample.js        regenerates the bundled sample library
unity-plugin/PolyVault/    Unity 6 Editor package (UPM)
docs/TECHNICAL.md          this file
```

---

## Processes & IPC

`preload.js` exposes a minimal, frozen API to the renderer through
`contextBridge` (context isolation on, `nodeIntegration` off, sandbox on):

| Renderer method | IPC channel | Purpose |
| --- | --- | --- |
| `addLibrary()` | `assetvault:addLibrary` | Opens a folder dialog and registers a library |
| `removeLibrary(id)` | `assetvault:removeLibrary` | Unregisters a library |
| `getState()` | `assetvault:getState` | `{ name, version, libraries, jobs }` |
| `getServerInfo()` | `assetvault:getServerInfo` | `{ host, port }` of the bridge |

---

## Library data model

`/api/library` returns `{ libraries: LibraryScan[] }`. Each scan is produced by
`scanLibrary(libRecord, { getTags, getMeta })`.

```
LibraryScan
├── id, name, path
├── scannedAt                     ISO instant this scan ran
├── totalAssets, assetCount, fileCount, sizeBytes
├── kindCounts                    { mesh: 2, texture: 1, … } aggregated
├── tags: string[]                aggregated, sorted, unique
├── description                   root description (from meta store)
├── created, updated              earliest birth / latest mtime below
├── tree: TreeNode[]              hierarchical index (unlimited depth)
└── assets: Asset[]               flat list (all folders that are assets)
```

```
TreeNode (type 'container' | 'asset')
├── rel                           '3d/Props/Furniture'
├── name
├── count                         direct children for containers
├── assetCount / fileCount / sizeBytes   (containers: aggregated subtree)
├── kindCounts / tags / created / updated / description
├── path                          absolute folder path
└── children: TreeNode[]          (containers only)

Asset
├── id                            stable hash of absolute path
├── name, category (top-level section)
├── relPath, folder (absolute), imported (bool)
├── preview { name, path }        first preview image found
├── importables[ { name, path, rel, kind } ]
├── importable (bool)
├── fileCount, sizeBytes, kinds[]
├── created / updated             birthtime / mtime of the folder
└── tags[]                        stored per-asset tags
```

`asset.id` is `hashString(absPath)` — stable across renames on the same disk
location. `findAssetById`/`inSubtree` in the renderer use `relPath` + `rel`
prefix matching for folder filtering.

---

## The scanner

`src/main/library.js` walks a library folder recursively:

1. **Ignore markers** — a folder containing `.assetvault-ignore` or `.nomedia`
   is skipped entirely.
2. **Asset vs container** — a folder is an *asset* if it directly contains a
   preview image **or** an importable file. The preview image itself never
   counts as the importable.
3. **Previews** — `preview.png/.jpg/.jpeg/.webp/.gif` (first match wins).
4. **Importables** — extensions mapped through `kindOfExt(ext)`:
   `unitypackage | mesh | texture | audio | video | font | script | material`
   plus raw extension fallbacks; anything else → `other`.
5. **Aggregation** — every container and the library root roll up
   `assetCount`, `fileCount`, `sizeBytes`, `kindCounts`, sorted unique `tags`,
   and subtree `created`/`updated` bounds from their descendants.
6. **Tags/meta injection** — via the `getTags`/`getMeta` callbacks so the
   scanner stays storage-agnostic. `getTags` results are coerced with
   `Array.isArray(...) ? ... : []` (safety against malformed stores).

The scanner re-runs on *every* `/api/library` request. For small-medium
libraries that is cheap; the renderer avoids re-painting when the result is
unchanged (see [Renderer & UI state](#renderer--ui-state)).

---

## Bridge HTTP API

Base URL `http://127.0.0.1:7100`. All responses are JSON
(`Cache-Control: no-store`). CORS is open (`*`) because the bridge is
loopback-only.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/status` | Health + registered libraries |
| GET | `/api/library` | Full rescanned library tree + assets (nested) |
| GET | `/api/meta` | All stored descriptions `{ absPath: { description } }` |
| PUT | `/api/meta` | Set a folder description `{ path, description }` (empty deletes) |
| GET | `/api/tags` | All stored tags `{ absPath: string[] }` |
| PUT | `/api/tags` | Set tags `{ path, tags[] }` — lowercased/trimmed/deduped, max 64 |
| POST | `/api/import-job` | Queue an asset import `{ assetId, assetName, category, libraryName, assetFolder, tags, importables }` |
| GET | `/api/import-jobs` | All jobs (history + status) |
| GET | `/api/unity/import-jobs` | Active (non-terminal) jobs — what the plugin polls |
| POST | `/api/unity/import-jobs/{id}/complete` | Complete a job (`{ note }`) |
| POST | `/api/unity/import-jobs/{id}/failed` | Fail a job (`{ note }`) |
| GET | `/api/preview?path=…` | Preview image stream (whitelisted extensions + library roots only) |
| GET | `/__diag?action=…` | Test automation probe (below) |

**Guards (always enforced):**

- `PUT /api/tags` and `PUT /api/meta`: 400 if `path` missing, 403 if the
  resolved path is outside a registered library.
- `POST /api/import-job`: 400 if `assetFolder`/`importables` missing/invalid,
  403 if the folder is outside a library.
- `GET /api/preview`: 400 unsupported extension; 403 outside a library;
  404 missing file.
- Bodies are capped at 2 MB (`readBody`).
- Port/host are configurable via `asset-vault-settings.json` → `server`.

### Job model

```
{ id (uuid), assetId, assetName, category, libraryName, assetFolder,
  tags[], importables[], status, createdAt, updatedAt, note }
status ∈ pending | processing | done | failed
```

Terminal states are `done` / `failed`. Jobs live in-memory on the bridge and
are persisted to `asset-vault-jobs.json` via `onJobsChanged`.

### `__diag` (test automation)

Executes JavaScript inside the renderer and returns UI metrics. Actions:

| Action | Effect |
| --- | --- |
| `selectRel:<rel>` | Clicks the tree row whose name equals `<rel>` |
| `selectFirstCard` | Clicks the first asset card |
| `rescan` | Clicks the Rescan button |
| `theme:<name>` | Applies a theme via the toolbar select |

Response metrics include `libs`, `treeRows`, `cards`, `dot`,
`detail` (detail h2), `view` (dataset.view), `metaRows`, `descEditors`,
`contTagChips`, `theme`, `splitters`, `sbW`, `trw` (first tree-row paddings).

---

## Import job lifecycle

1. Renderer `POST /api/import-job` with the asset folder whitelist-checked.
2. Job created as `pending`; persists; visible in queue badge on the card
   and in the details panel.
3. Unity plugin polls `GET /api/unity/import-jobs` (interval default 5 s) and
   sets the job `processing` while importing.
4. On success the plugin calls `/complete` (or `/failed` with a note).
5. Renderer polls `GET /api/import-jobs` every 5 s and re-paints *only* when
   a job's status or `updatedAt` changes.

Plugin import targets:
`Assets/PolyVaultImports/<Library>/<Category>/<Asset>/…`
(`AssetVaultImporter.ImportRoot`). `.unitypackage` files are handed to Unity's
interactive importer; everything else is copied. Tags are written alongside
the imported asset as `polyvault.tags.json`. `Sanitize` neutralises invalid
filename chars; `DestinationFor` guards against path-traversal in `rel` fields.

---

## Renderer & UI state

`ui/renderer.js` keeps a single mutable `state` object:

```
serverUrl        // bridge base URL from getServerInfo()
libsMeta         // registered library records
libraries        // full scans from /api/library
tagData, metaData
jobsByAsset      // Map<assetId, job>
activeLibId, activeNode ({libId, rel} folder filter)
expanded         // Set of `libId::rel` expand keys
selectedAssetId, detail ({kind: asset|container|library, …})
search, online, theme
```

**Rendering strategy** (this is what stopped the "constant refreshing"):

- `refreshLibrary()` (every 20 s) re-fetches the library/tags/meta, computes a
  JSON signature over the payload *with `scannedAt` stripped* (it changes every
  poll), and **skips rendering entirely when the signature is unchanged**.
  DOM rebuilds (sidebar/grid/detail) only happen when data genuinely changed.
- `pollJobs()` (every 5 s) only re-renders grid/detail when the job map
  actually changed (size, status, or `updatedAt` differ).
- Tree rows are rendered flat and **indented by depth**
  (`calc(10px + depth * 20px)`) — no nested `<ul>`; container expansion is
  driven purely by the `expanded` set. All containers expand by default on
  first load.
- Cards re-run their entrance animation only on real re-renders.

**Interaction & accessibility (UX pass):**

- Tree rows are `role="treeitem"`, focusable (`tabindex=0`), activated by
  Enter/Space, and show a `:focus-visible` ring.
- Caret/toggle buttons are ≥ 26×26 px hit targets; rows ≥ 32 px tall;
  library headers ≥ 42 px; inline SVG icons (16–18 px) inherit
  `currentColor` so they follow both themes.
- The remove-library button has a proper 24×24 hit area and hover state.

---

## Theming & layout

There are exactly **three** themes, all built on the brand palette extracted
from `branding/logo.png` (coral `#fa472b`, amber `#fcb72c`, gold `#fdc731`,
warm near-black `#250e17`):

- **Default** — the brand warm-dark look (`#170f14` base).
- **Dark** — a true near-black neutral theme (`#0a0b0f` base).
- **Light** — a true light theme with high-contrast, readable text.

- Theme state lives on `data-theme` on `<html>` (`default | dark | light`);
  the stored choice in `localStorage` key `av.theme` wins, otherwise
  Default. `style.css` also defines the Default dark variable set on
  `:root`, so the very first paint is always on-brand.
- All palette colors are CSS custom properties per theme; `color-scheme`
  follows so native controls (scrollbars, inputs) match. `--grad` is the
  brand gradient used for selection highlights and focus interactions.
- Fonts: **Montserrat** is bundled offline in `ui/assets/fonts/` (via the
  `@fontsource/montserrat` devDependency, copied by `npm run icons`) and
  applied globally with per-weight `@font-face` rules.
- Branding: the toolbar shows the **horizontal wordmark**
  (`branding/logo-horizontal.png` → `ui/assets/logo.png`, aspect-preserving
  scale); the favicon/app image is `ui/assets/icon.png` (square art from
  `branding/icon.png`). Both are emitted by `npm run icons`
  (`tools/gen-icon.js`). On the Light theme the wordmark sits on a dark chip
  so the white text stays readable.

## Card selection (no re-render)

Selecting a card only toggles `.selected` on existing cards and re-renders
the details panel — the grid is **not** rebuilt, so there is no flicker and
entrance animations don't replay. Full grid rebuilds happen only when the
underlying data changes (`refreshLibrary()` diff-skip) or filters/search
change.

## Unity connectivity indicator

The bridge tracks `lastUnitySeen` (epoch ms) every time an
`/api/unity/*` route is hit — i.e. when the Unity Editor plugin polls
`/api/unity/import-jobs` or reports job completion. `GET /api/status` returns
`unitySeenAt`. The renderer polls `/api/status` every 5 s and shows
**unity: connected** while a poll arrived within the last 15 s
(`UNITY_TIMEOUT_MS`), otherwise **unity: not connected** (orange status dot,
drawn via the `--accent` brand color).

## Tag filtering

- Tags live in `state.tagData` (`{ absPath: string[] }`) and are also merged
  onto each scanned asset as `a.tags`.
- `assetsFiltered(false)` filters by library/folder/search; passing
  `true` additionally requires **all** active tags (`state.activeTags`,
  AND semantics).
- The toolbar **Tags** dropdown (`initTagPopover()` + `renderTagPopover()`)
  lists every tag visible in the current view with an asset count; clicking
  a row toggles it in `state.activeTags`, mirrored live by the chips in
  `#tag-filter`. The badge shows how many filters are active.

Panels are resized with two pointer-driven splitters. Widths persist in
`localStorage` keys `av.layout.sidebar` (200–520) and `av.layout.detail`
(300–620, inverted drag because it anchors on the right edge).

---

## Storage & migration

Stores are plain JSON via `src/main/store.js` in `app.getPath('userData')`
(no Electron deps in the class — it is unit-testable on its own):

| File | Schema |
| --- | --- |
| `asset-vault-settings.json` | `{ libraries: [{id,name,path,addedAt}], server: { host, port } }` |
| `asset-vault-tags.json` | `{ tags: { [absPath]: string[] } }` |
| `asset-vault-meta.json` | `{ meta: { [absPath]: { description } } }` |
| `asset-vault-jobs.json` | `{ jobs: Job[] }` |

**Migration:** pre-0.3 builds used the product name "Asset Vault", so their
userData folder is `…/Asset Vault`. On first launch under the new name,
`migrateUserData()` copies the four JSON files from the old folder to the new
`…/Poly Vault` folder when the latter does not exist yet (skipped entirely when
`ASSETVAULT_USER_DATA` is set, i.e. tests).

---

## Security model

- The bridge binds to **127.0.0.1** only (loopback) and serves no secrets.
- Every path-based endpoint resolves with `path.resolve` and checks
  `withinLibrary()` against registered library roots (both the root itself and
  descendants are permitted).
- `GET /api/preview` is restricted to a fixed image-extension allow-list.
- The renderer runs with `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`; CSP in `index.html` restricts `default-src 'self'`,
  images/connects to loopback only, and forbids `unsafe-eval`.
- On Windows, request single-instance lock; `setWindowOpenHandler` forces all
  `http(s)` links to the system browser.

---

## Packaging & signing

Powered by [electron-builder](https://www.electron.build) —
see `electron-builder.yml`.

**Icons** (`npm run icons` → `tools/gen-icon.js`, pure Node + zlib, no image
deps, draws the gradient-diamond mark):

- `build/icon.ico` — PNG-embedded ICO (256), Windows
- `build/icon.png` — PNG (512), Linux + AppImage/deb
- `build/icon.icns` — multi-size ICNS (128/256/512/1024 PNG entries), macOS

**Targets:**

| OS | electron-builder target | Artifact |
| --- | --- | --- |
| Windows | `nsis` (x64) | `dist/PolyVault-Setup-<ver>.exe` |
| Linux | `AppImage` + `deb` (x64) | `dist/PolyVault-<ver>-x86_64.AppImage`, `PolyVault-<ver>-amd64.deb` |
| macOS | `dmg` + `zip` (x64 + arm64) | `dist/PolyVault-<ver>-{x64,arm64}.{dmg,zip}` |

**Signing:**

- Windows `exe` is unsigned by default (SmartScreen prompt). Signing: set
  `CSC_LINK`/`CSC_KEY_PASSWORD` (or `win.certificateFile`/`Password`).
- Linux packages need no signing, but `deb` is easiest to install with
  `sudo dpkg -i` on Debian/Ubuntu.
- macOS is configured with `identity: null` — **unsigned**. DMG creation
  requires macOS tooling (`hdiutil`), so `npm run dist:mac` must run on a Mac.
  For signed+notarised distribution, install Apple Developer certificates in
  the keychain, remove `identity: null`, and add `mac.notarize`.

**Cross-platform notes:** AppImage files embed the host-OS glibc; build them
on your oldest supported distro or rely on `APPIMAGE_EXTRACT_AND_RUN=1`.

---

## Test harness

- `node tests/smoke.js` — creates a fixture tree (nested, tagged, described),
  runs `scanLibrary` (asserts aggregation/kinds/dates/tags/descriptions) and
  boots the bridge with temp stores (asserts preview auth guard, tags + meta
  round-trips, 403 for outside-library paths, job queue transitions).
- `node tests/e2e.js` — spawns the real Electron main with
  `ASSETVAULT_USER_DATA` + `ASSETVAULT_BOOT_LIBRARY`, drives the UI through the
  HTTP `__diag` actions, and asserts rendered state: library registered,
  tree rows/cards present, container detail (meta rows + descendant tag
  chips), asset detail (description editor), theme switching, and the two
  splitters. Polls are handled by `waitForDiag(action, predicate, what)`, which
  repeats actions until a timeout while the renderer's 5 s job-poll runs.

Both tests must pass before a release; they are the final verification step of
the packaging pipeline documented in the [README](../README.md).

---

## Environment hooks

| Variable | Effect |
| --- | --- |
| `ASSETVAULT_USER_DATA` | Redirects `userData` (headless test isolation) |
| `ASSETVAULT_BOOT_LIBRARY` | Registers a library at boot without UI |
| `ASSETVAULT_DEBUG` | Streams renderer console messages to stdout |

---

## Roadmap

- Drag & drop an asset into a scene (via plugin `OpenAsset`).
- Per-asset rating alongside tags/descriptions.
- Blender-based format conversion (FBX ⇄ GLB) when importing.
- Watch folders for changes instead of rescans.
- Multiple machines / LAN sharing of a library.