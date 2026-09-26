# Poly Vault — Specification

Product & technical specification for the **Poly Vault** desktop asset manager
and its Unity 6 bridge. This is the authoritative reference for *what the
product does*: full capability list, functional behaviours, API contracts,
data shapes, and edge cases.

**Product:** Poly Vault · **Version:** 0.4.0 · **Author:** Zeeshan Qaswar ·
**License:** MIT

Contents:

- [1. Scope](#1-scope)
- [2. Terminology](#2-terminology)
- [3. Capability catalog](#3-capability-catalog)
- [4. Library concept & scanning rules](#4-library-concept--scanning-rules)
- [5. Browsing & navigation](#5-browsing--navigation)
- [6. Search, tags & filtering](#6-search-tags--filtering)
- [7. Asset details & descriptions](#7-asset-details--descriptions)
- [8. Import to Unity](#8-import-to-unity)
- [9. Bridge HTTP API](#9-bridge-http-api)
- [10. Job lifecycle](#10-job-lifecycle)
- [11. Unity Editor plugin](#11-unity-editor-plugin)
- [12. Themes, typography & layout](#12-themes-typography--layout)
- [13. Persistence & migration](#13-persistence--migration)
- [14. Security, privacy & platform behaviour](#14-security-privacy--platform-behaviour)
- [15. Rendering & performance behaviour](#15-rendering--performance-behaviour)
- [16. Environment & runtime hooks](#16-environment--runtime-hooks)
- [17. Packaging & distribution](#17-packaging--distribution)
- [18. Verification matrix](#18-verification-matrix)
- [19. Out of scope & roadmap](#19-out-of-scope--roadmap)

---

## 1. Scope

Poly Vault is an **offline-first desktop application** that:

1. turns local folders into browsable, searchable **asset libraries**;
2. annotates folders with **tags** and **descriptions**, stored locally;
3. queues importable assets for a **Unity 6 Editor** via a loopback HTTP bridge.

Out of scope in 0.4: cloud sync, multi-user, LAN sharing (roadmap), preview
rendering of model/3D files, batch editing, ratings.

## 2. Terminology

| Term | Meaning |
| --- | --- |
| Library | A registered root folder containing category subfolders |
| Container | Any folder that is *not* an asset (used for organisation) |
| Asset | A folder directly containing a preview image or an importable file |
| Preview | Thumbnail image drawn from a folder's `preview.*` file |
| Importable | A file with an extension in the import allow-list |
| Job | A queued request to import one asset into a Unity project |
| Bridge | The local HTTP server on `127.0.0.1:7100` |
| Plugin | The Unity Editor UPM package under `unity-plugin/PolyVault` |

## 3. Capability catalog

| # | Capability | Behaviour | Where |
| --- | --- | --- | --- |
| C1 | Add library | Folder picker; a library must contain category subfolders | Sidebar "+" |
| C2 | Remove library | Unregister without deleting any file | Sidebar row menu |
| C3 | Recursive scan | Unlimited folder depth; aggregation of counts/sizes/kinds | `library.js` |
| C4 | Tree browsing | Containers/asset rows, expand/collapse, indent-by-depth | Left panel |
| C5 | Card grid | Thumbnail cards for every asset in the current view | Centre panel |
| C6 | Preview images | `preview.*` served through the bridge (allow-listed) | `GET /api/preview` |
| C7 | Details panel | Dates, counts, sizes, kinds, tags, description | Right panel |
| C8 | Search | Text match across the current view (name, tags, and description) | Toolbar |
| C9 | Tag filter | AND-filter cards by selected tags; chips + badge | Toolbar dropdown |
| C10 | Tag editing | Add/remove tags on any asset, folder, or library; lowercased, deduped, ≤64; optional cascade to descendants | Details panel |
| C11 | Descriptions | Free-text per asset/folder/library; empty descriptions open straight into edit mode | Details panel |
| C12 | Import to Unity | Queue an asset import job to the bridge | Card / details |
| C13 | Job visibility | Queue badge on cards; status in detail; history | `jobsByAsset` |
| C14 | Unity indicator | Live *unity: connected* chip while plugin polls | Toolbar |
| C15 | Update | Scoped re-scan + store re-check for the current selection (asset → folder → library → all) with progress | Toolbar |
| C16 | Themes | Default / Dark / Light; persisted per user | Toolbar select |
| C17 | Resizable layout | Three-pane splitters; widths persisted | Panels |
| C18 | Ignore markers | `.assetvault-ignore` / `.nomedia` skips subtree | Scanner |
| C19 | Legacy migration | 0.2 "Asset Vault" data copied to new userData once | Main process |
| C20 | Single instance | Second launch focuses the running window (Windows) | Main process |
| C21 | No menu bar | File/Edit/View/Window menu removed | Main process |
| C22 | Flicker-free selection | Card click only updates highlight + details | Renderer |
| C23 | Collapse all | Folds every library/folder tree and returns to the top-level view | Sidebar |
| C24 | Open folder | Reveals a folder in the OS file explorer (only footer action; no path text) | Details panel |
| C25 | Automatic store enrichment | New assets are looked up in the Unity Asset Store automatically: description saved, tags derived; manual descriptions never overwritten | Main process |
| C26 | Tag suggestions | Tag editor suggests existing tags in the app while typing | Details panel |
| C27 | Import file list | "Import files" lists only `.unitypackage` filenames | Details panel |

## 4. Library concept & scanning rules

### 4.1 Asset vs container

A folder is an **asset** iff it directly contains:

- a preview image **or** an importable file.

Pure folder-folder structures are **containers**. The preview image itself is
never counted as an importable — a folder with *only* a preview is browse-only
(`importable: false`, no Import button).

### 4.2 Previews

`preview.png`, `preview.jpg`, `preview.jpeg`, `preview.webp`, `preview.gif`
(first existing match in that priority order; `.png` wins over `.jpg`, etc.).
Served through `GET /api/preview`, never embedded as a file path.

### 4.3 Importable file kinds

| Kind | Extensions |
| --- | --- |
| unitypackage | `.unitypackage` |
| scene / prefab | `.prefab`, `.scene` |
| mesh | `.fbx .obj .glb .gltf .blend .dae .3ds .dxf .stl .max .c4d .mb .ma .abc .x .lwo .lws .ply` |
| texture | `.png .jpg .jpeg .tga .psd .tif .tiff .bmp .gif .exr .hdr .dds .ktx .pvr` |
| font | `.ttf .otf .dfont` |
| audio | `.wav .mp3 .ogg .aif .aiff .flac .xm .mod .it .s3m` |
| video | `.mp4 .mov .avi .webm .m4v .mpg .mpeg .asf .wmv` |
| animation | `.bvh .htr .anim .controller .overridecontroller` |
| material | `.mat .spriteatlas .mask` |
| script / assembly | `.cs .dll .asmdef .asmref .shader .cginc .hlsl` |
| fx / playable | `.mixer .playable .rendertexture .flare .halo .lighting` |

Anything else in a folder body is ignored for importability (but still counted
in `fileCount`). `kindOfExt()` buckets each importable; absent buckets (e.g. a
`.txt`) classify as `other` and are never importable.

### 4.4 Ignore markers

Any folder containing a file named `.assetvault-ignore` or `.nomedia` is
skipped **entirely** (its whole subtree).

### 4.5 Aggregation

Every container and the library root roll up from descendants:

`assetCount`, `fileCount`, `sizeBytes`, `kindCounts`
(`{ mesh: 2, texture: 1, … }`), a sorted-unique merged `tags` list, and subtree
`created`/`updated` bounds (earliest birthtime / latest mtime).

### 4.6 Identity

`asset.id` = stable hash of the absolute path (survives renames only if the
path stays put; offline store keys are absolute paths). Renderer folder
filtering uses `relPath` + `rel` prefix matching.

## 5. Browsing & navigation

- **Sidebar tree** — library roots, then containers/assets, indented by depth
  (`calc(10px + depth * 20px)`), expanded by default on first load. Rows are
  `role="treeitem"`, focusable, Enter/Space toggles expansion/selection. A
  **Collapse all** button clears every `lib::*`/`<lib>::<rel>` expansion key
  and, when a nested folder was selected, returns to the all-libraries view.
- **Centre grid** — one card per asset in the filtered view; card shows
  preview, name, kind counts, and a queue badge when a job exists.
- **Details panel** — for the selected library/container/asset: created,
  updated, counts, size, kind breakdown, an editable tag list, and a description
  editor. The footer contains only a full-width **Open folder** button — the
  absolute path is never printed. Assets additionally list their
  `.unitypackage` files by name under **Import files**.
- **Drill-down** — selecting a container filters the grid + tree to that
  container; breadcrumbs / active node tracking keep the view consistent.

## 6. Search, tags & filtering

- **Search** matches the current view (library/folder-scoped) against asset
  **names**, **tags** (substring), and **descriptions** (`includes`, lowercase).
- **Tag filter** (`assetsFiltered(true)`) applies **AND** semantics — an asset
  must have *all* active tags. The toolbar **Tags** popover lists every tag
  visible in the current view with its asset count; toggling updates the chips
  in `#tag-filter` and the `filter-count` badge.
- Tags are **lowercased, trimmed, deduplicated**, max 64 per item
  (`PUT /api/tags`, `POST /api/tags/apply`).
- The **tag editor** (assets, folders, libraries) shows current tags as
  removable chips, suggests up to 8 existing tags in the app while typing, and
  offers a **Cascade to n items inside** toggle (default **on** for
  containers/libraries, absent for assets). Cascade applies one request through
  `POST /api/tags/apply` covering the item and every descendant asset.
- Container/library tag editors also list the tags their **contents** already
  use (aggregated, deduplicated, capped at 12 chips with an `+n more` tail) as
  muted `inside (n)` chips; clicking one filters the grid by that tag. They are
  read-only there — they belong to the descendant assets.

## 7. Asset details & descriptions

- `GET /api/meta` returns all stored records
  `{ [absPath]: { description, name, url, found, fetchedAt } }`.
- `PUT /api/meta` sets a description; empty string **deletes** the record.
- An **empty** description opens directly in edit mode (textarea, placeholder,
  Cancel/Save). A **stored** description renders as text with a quiet **Edit**
  action; Ctrl/⌘+Enter or **Save** commits, **Cancel** reverts, and a
  saved/error status line reports the result.
- **Automatic store enrichment** — every asset without a `fetchedAt` marker is
  looked up in the Unity Asset Store by its folder name in the **main process**
  (3 concurrent lookups, ≥150 ms apart). A match stores the description plus
  `name`/`url`/`found: true`; a miss stores `found: false` with an empty
  description. A lookup that finds nothing **never** overwrites a description
  the user wrote by hand.
- Tags are **derived** from the store result (`deriveTags(name, category,
  description)`) and merged into the existing tag list, capped at 64.
- **Update** (toolbar) re-scans and re-enriches the current selection —
  asset → its folder → its library → everything — forcing a fresh store lookup
  for records whose previous lookup found nothing. Progress is reported as
  `Fetching descriptions… n/total` until the main-process queue drains.
- **Open folder** (`assetvault:openInExplorer`) reveals any library/folder/asset
  directory in the OS file explorer.

## 8. Import to Unity

- Any importable asset can be queued from the card or detail panel.
- The desktop app posts a job; the **Unity plugin** (while open) pulls it and
  imports into `Assets/PolyVaultImports/<Library>/<Category>/<Asset>/…`.
- **Copies only** — the source asset folder is never modified, moved, or
  deleted. `<name>.polyvault.tags.json` is written alongside each import.
- `.unitypackage` jobs are handed to Unity's interactive importer; everything
  else copies automatically (or on manual `Import now`).

## 9. Bridge HTTP API

Base URL: `http://127.0.0.1:7100` (configurable via `server` in settings).
JSON responses, `Cache-Control: no-store`, CORS `*` (loopback only).
RequestBody cap: **2 MB**.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/status` | Health + libraries + `unitySeenAt` |
| GET | `/api/library` | Full rescanned tree + assets + aggregates; queues enrichment for new assets |
| POST | `/api/update` | Scoped re-scan + forced re-check (`{ scope }` → libraries, targets, status) |
| GET | `/api/enrichment` | Store-lookup queue status (`state`, `pending`, `active`, `done`, `message`) |
| GET | `/api/meta` | `{ [absPath]: { description, name, url, found, fetchedAt } }` |
| PUT | `/api/meta` | Set/delete description (`{ path, description }`) |
| GET | `/api/tags` | `{ [absPath]: string[] }` |
| PUT | `/api/tags` | Set tags (`{ path, tags: string[] }`) |
| POST | `/api/tags/apply` | Add/remove tags across many paths (`{ paths[], add[], remove[] }`) — used by cascade |
| POST | `/api/import-job` | Queue a job |
| GET | `/api/import-jobs` | All jobs (history + status) |
| GET | `/api/unity/import-jobs` | Active (non-terminal) jobs — plugin poll target |
| POST | `/api/unity/import-jobs/{id}/complete` | Complete a job (`{ note }`) |
| POST | `/api/unity/import-jobs/{id}/failed` | Fail a job (`{ note }`) |
| GET | `/api/preview?path=…` | Preview image stream |
| GET | `/__diag?action=…` | Test-automation probe (renderer metrics) |

### 9.1 `GET /api/status` → 200

```jsonc
{
  "ok": true,
  "name": "Poly Vault",
  "version": "0.4.0",
  "time": "<ISO>",
  "libraryCount": 1,
  "libraries": [{ "id": "…", "name": "…", "path": "C:\\…" }],
  "unitySeenAt": 0  // epoch ms of last /api/unity/* request; 0 = never
}
```

### 9.2 `GET /api/library` → `{ libraries: LibraryScan[] }`

`LibraryScan`:

```jsonc
{
  "id": "…", "name": "…", "path": "C:\\…",
  "scannedAt": "<ISO>",              // changes every scan – renderer strips it
  "totalAssets": 12, "assetCount": 12, "fileCount": 48, "sizeBytes": 123456789,
  "kindCounts": { "mesh": 2, "texture": 1 },
  "tags": ["furniture"], "description": "…",
  "created": "<ISO>", "updated": "<ISO>",
  "tree": [ /* TreeNode[] */ ],
  "assets": [ /* Asset[] */ ]
}
```

`TreeNode`:

```jsonc
{
  "rel": "3d/Props/Furniture", "name": "…",
  "type": "container" | "asset",
  "count": 3,                        // direct children (containers only)
  "assetCount": 4, "fileCount": 9, "sizeBytes": 111,
  "kindCounts": {}, "tags": [], "created": "<ISO>", "updated": "<ISO>",
  "description": "…",
  "path": "C:\\…\\3d\\Props\\Furniture",
  "children": []                     // containers only
}
```

`Asset`:

```jsonc
{
  "id": "<hash>", "name": "Chair", "category": "3d",
  "relPath": "3d/Props/Furniture/Chair", "folder": "C:\\…\\Chair",
  "imported": false,
  "preview": { "name": "preview.png", "path": "C:\\…\\preview.png" },
  "importables": [{ "name": "chair.fbx", "path": "…", "rel": "…", "kind": "mesh" }],
  "importable": true, "fileCount": 3, "sizeBytes": 12,
  "kinds": ["mesh", "other"], "created": "<ISO>", "updated": "<ISO>",
  "tags": ["furniture"]
}
```

### 9.3 Guards (always enforced)

| Endpoint | Validation |
| --- | --- |
| `PUT /api/tags`, `PUT /api/meta` | 400 if `path` missing; 403 if resolved path is outside a registered library |
| `POST /api/tags/apply` | 400 if `paths` missing/empty; 403 if any path is outside a registered library |
| `POST /api/update` | 400 if `scope` is malformed; unknown scope types fall back to `all` |
| `POST /api/import-job` | 400 if `assetFolder`/`importables` missing/invalid; 403 if folder outside a library |
| `GET /api/preview` | 400 unsupported extension; 403 outside a library; 404 missing file |
| all bodies | `readBody` cap 2 MB |

`withinLibrary()` resolves with `path.resolve` and permits the library root and
all descendants; nothing else.

### 9.4 `__diag` probe

Executes sandboxed JS in the renderer and returns UI metrics for the test
harness. Actions: `selectRel:<rel>`, `selectFirstCard`, `update` (alias
`rescan`), `theme:<name>`, `tagpop`, `tagpopoff`, `tag:<tagName>`. Metrics:
`libs, treeRows, cards, dot, detail, view, metaRows, descEditors, tagInputs,
cascadeToggles, tagSuggestions, contTagChips, updateBtn, updateStatus,
updateStatusShown, importHeading, importFiles, fileRows, openPathBtns,
pathTexts, theme, splitters, sbW, trw, rr, brandImg, brandW, accent, font, bg,
text, popRows, cnt, unity, unityDot`.

## 10. Job lifecycle

```
pending ──► processing ──► done
                 │
                 └────────► failed
```

1. Renderer `POST /api/import-job` (whitelist-checked folder).
2. Job saved as `pending`; badge appears on the card + detail.
3. Plugin polls `GET /api/unity/import-jobs` (5 s default) and marks
   `processing` while importing.
4. Plugin calls `/complete` or `/failed` (+ note).
5. Renderer polls `GET /api/import-jobs` (5 s) and re-paints only on change.

```jsonc
{ "id": "<uuid>", "assetId": "…", "assetName": "Chair", "category": "3d",
  "libraryName": "MyLibrary", "assetFolder": "C:\\…",
  "tags": [], "importables": [],
  "status": "pending" | "processing" | "done" | "failed",
  "createdAt": "<ISO>", "updatedAt": "<ISO>", "note": null }
```

Terminal states: `done`, `failed`. Jobs persist to `asset-vault-jobs.json`.

## 11. Unity Editor plugin

- **Install:** copy `unity-plugin/PolyVault` to the project's `Packages/` or
  add via Package Manager → *Add package from disk*.
- **Menu:** Window → Poly Vault → Poly Vault.
- **Settings:** Server URL (`http://127.0.0.1:7100`), *Sync in background*
  (interval poll while open), *Auto-import safe jobs* (all but
  `.unitypackage`).
- **Import target:** `Assets/PolyVaultImports/<Library>/<Category>/<Asset>/…`
  (`AssetVaultImporter.ImportRoot`).
- **Safety:** `Sanitize` neutralises invalid filename characters;
  `DestinationFor` rejects path traversal in `rel` fields.
- **Tags sidecar:** `polyvault.tags.json` written beside the imported asset.

## 12. Themes, typography & layout

### 12.1 Themes

| Theme | Base | Notes |
| --- | --- | --- |
| Default | `#170f14` | brand warm-dark; first paint (defined on `:root`) |
| Dark | `#0a0b0f` | true near-black neutral |
| Light | `#f2f2f5` | readable high-contrast |

- State: `data-theme` on `<html>`; localStorage `av.theme` wins, else Default.
- Palette (from brand art): coral `#fa472b`, amber `#fcb72c`, gold `#fdc731`,
  warm near-black `#250e17`. All colors are CSS custom properties per theme;
  `color-scheme` follows the theme so native controls match.

### 12.2 Typography

Inter bundled offline
(`ui/assets/fonts/inter-latin-{300,400,500,600,700}-normal.woff2`),
applied via `@font-face` → `body`; `button,input,select,textarea` inherit.
Headings, breadcrumbs, and card titles use tight negative tracking.
Icons are inline lucide.dev SVGs (stroke via `currentColor`, `ui/renderer.js`
`ICONS` map) — no icon font or network fetch.

### 12.3 Layout

- Bento surface: toolbar, sidebar, grid, and detail are rounded-xl cards with
  hairline 1px borders (`white/10` dark, `black/10` light), translucent
  backdrops, and a global set of soft ambient radial gradients in the body —
  no heavy drop shadows. Spacing follows an 8px grid.
- Three panes: sidebar / grid / detail, split by two pointer-driven splitters.
- Persisted widths: `av.layout.sidebar` (200–520), `av.layout.detail`
  (300–620; inverted drag, anchors right).
- Toolbar: brand wordmark, theme select pill, Tags dropdown (lucide tag
  icon), Update (refresh icon) with its progress bubble, Add Library (plus
  icon), search field with a lucide magnifier, server status + Unity
  connection chip.
- Brand mark: horizontal wordmark at 52 px (`branding/logo-horizontal.png` →
  `ui/assets/logo.png`, 640 px-tall asset, aspect-preserving); dark chip
  backdrop on the Light theme.

## 13. Persistence & migration

| File (`userData`/Poly Vault) | Schema |
| --- | --- |
| `asset-vault-settings.json` | `{ libraries: [{id,name,path,addedAt}], server: {host, port} }` |
| `asset-vault-tags.json` | `{ tags: { [absPath]: string[] } }` |
| `asset-vault-meta.json` | `{ meta: { [absPath]: { description, name, url, found, fetchedAt } } }` |
| `asset-vault-jobs.json` | `{ jobs: Job[] }` |

**Migration:** pre-0.3 userData was `…/Asset Vault`; on first launch under the
new name, `migrateUserData()` copies the four JSON files into `…/Poly Vault`
when the target is empty (skipped when `ASSETVAULT_USER_DATA` is set).

## 14. Security, privacy & platform behaviour

- Bridge binds to **127.0.0.1** only; publishes no secrets; CORS `*` is
  acceptable because it is unreachable beyond loopback.
- Every path endpoint validates against registered library roots via
  `withinLibrary()`.
- `/api/preview` allow-list: `.png .jpg .jpeg .webp .gif`.
- Renderer: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`; CSP forbids `unsafe-eval`, restricts `default-src 'self'`,
  images/connects to loopback only.
- Single-instance lock on Windows; `setWindowOpenHandler` routes all
  `http(s)` links to the system browser.
- No telemetry, no accounts, no cloud. Menu bar removed
  (`Menu.setApplicationMenu(null)`).
- The single outbound request is the Unity Asset Store description lookup
  (public product page, no credentials, ~150 ms apart). `ASSETVAULT_NO_ENRICH=1`
  disables it entirely and is what the E2E test uses.

## 15. Rendering & performance behaviour

- Libraries rescan on every `/api/library` request (cheap for small/medium
  libraries); the renderer computes a signature **with `scannedAt` stripped**
  and skips ALL repaints when unchanged (this is what stopped "constant
  refreshing").
- Job polling re-renders only when the job map changes (size/status/`updatedAt`).
- Card selection never rebuilds the grid.
- Tree is rendered flat with indent-by-depth (no nested `<ul>`).
- Barriers: `refreshLibrary` 20 s, `pollJobs` 5 s, `pollUnityStatus` 5 s.

## 16. Environment & runtime hooks

| Variable | Effect |
| --- | --- |
| `ASSETVAULT_USER_DATA` | Redirect userData (test isolation) |
| `ASSETVAULT_BOOT_LIBRARY` | Register a library at boot without the picker |
| `ASSETVAULT_DEBUG` | Stream renderer console to stdout |

## 17. Packaging & distribution

| OS | Command | Artifacts |
| --- | --- | --- |
| Windows | `npm run dist` | `dist/PolyVault-Setup-<ver>.exe` (NSIS, x64, unsigned) |
| Linux | `npm run dist:linux` | AppImage + `.deb` (x64) |
| macOS | `npm run dist:mac` | DMG + zip (x64 + arm64; unsigned, must run on a Mac) |

Icons (`npm run icons`): `build/icon.ico` (256), `build/icon.png` (512),
`build/icon.icns` (128/256/512/1024), plus `ui/assets/{logo,icon}.png` and the
bundled Inter woff2s. CI: `.github/workflows/build.yml` builds all three
OSes on `v*` tags.

## 18. Verification matrix

| Check | Command | Asserts |
| --- | --- | --- |
| Scanner + bridge | `npm run smoke` | detection rules, aggregation, kinds, dates, tags/meta, preview guard, 403s, job state machine |
| Full app | `npm run e2e` | boot with fixture library, tree/cards, container + asset detail, description editor, theme switching, splitters |
| Asset pipeline | `npm run icons` | icons/logo/fonts regenerate (used by smoke/e2e build steps) |

Both tests must pass before a release.

## 19. Out of scope & roadmap

Planned (not in 0.4):

- Drag & drop an asset into a Unity scene (via plugin `OpenAsset`).
- Per-asset ratings alongside tags/descriptions.
- Blender-based FBX ⇄ GLB conversion on import.
- Folder watching instead of periodic rescans.
- LAN / multi-machine shared libraries.

This document tracks the **0.4** line. Implementation details and internals
live in [TECHNICAL.md](TECHNICAL.md).