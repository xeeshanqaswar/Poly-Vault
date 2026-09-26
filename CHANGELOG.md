# Changelog

All notable changes to **Poly Vault** are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com) and this project adheres to
[Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed

- **Preview caching** — `/api/preview` now answers with `Cache-Control: private,
  max-age=3600`, a weak `ETag` and `Last-Modified`, and returns `304 Not Modified`
  for `If-None-Match` / `If-Modified-Since`. Previously every grid re-render
  re-streamed each visible thumbnail from disk (`no-store`, no validator), so
  filtering, tag changes and search re-read the same images repeatedly.
- **Search debounce** — the toolbar search box waits 120 ms before re-rendering
  the grid instead of rebuilding it on every keystroke.

## [0.4.0] — 2026-09-26

Automatic enrichment + a bento UI refresh. New assets now describe and tag
themselves from the Unity Asset Store, and "Update" re-checks exactly what you
have selected.

### Added

- **Automatic store enrichment** — every newly discovered asset is looked up in
  the Unity Asset Store automatically (in the main process, throttled and
  deduplicated). The description is saved and tags are derived from the store
  name, category, and description text, so new assets arrive pre-described and
  pre-tagged. The manual "Fetch from store" button is gone.
- **Update** button (replaces "Rescan") — re-scans and re-enriches with scope
  matching the current selection: an asset updates just that asset, a folder
  updates its subtree, a library updates its whole library, and with nothing
  selected everything is updated. A progress bubble reports
  `Fetching descriptions… n/total` while the queue drains.
- **Cascading tag editor** — assets, folders, and libraries all get the same tag
  editor: existing tags as removable chips, inline suggestions from tags already
  in the app, and a "Cascade to n items inside" toggle that is on by default for
  folders and libraries so one assignment tags the whole subtree. Folders and
  libraries additionally list the tags their contents already use (filterable).
- **Collapse all** button on the sidebar — collapses every library and folder
  tree at once.
- **Open folder** button in the details panel — jumps to a library, folder, or
  asset's directory in the OS file explorer.
- **Bridge endpoints** — `POST /api/update` (scoped re-scan + forced store
  re-check), `GET /api/enrichment` (queue status), and `POST /api/tags/apply`
  (one request for a whole cascade).
- **`ASSETVAULT_NO_ENRICH=1`** env hook to disable store lookups (used by the
  end-to-end test).

### Changed

- **Descriptions are edited in place** — an empty description opens straight into
  an editable textarea; a description that was found in the store shows as text
  with a quiet "Edit" action, and saving shows a confirmation. Descriptions you
  write by hand are never overwritten by a later store lookup that finds nothing.
- **"Import files"** lists only the `.unitypackage` files in an asset, by name,
  instead of every file with its type and size.
- **Details footer** no longer prints the absolute path; the full-width
  **Open folder** button is the only action there.
- **Bento UI refresh** — the three-column layout is now a grid of rounded
  cards on soft ambient radial gradients: hairline 1px borders (white/10 on
  dark, black/10 on light) replace the heavy drop shadows, spacing is aligned
  to a consistent 8px scale, and containers use a rounded-xl corner radius.
- **lucide.dev icons** — all inline glyphs (tree carets, folder/box rows,
  toolbar actions, tag removal, open-folder, collapse-all, description editor)
  now come from the lucide icon set and inherit `currentColor`.
- **Inter typography** — the bundled font family switched from Montserrat to
  Inter (offline woff2, weights 300–700) with tighter letter-spacing on
  headings, breadcrumbs, and card titles.

### Fixed

- A failed **Update** no longer clears its own error message instantly; the
  reason stays visible for a few seconds.
- Folder and library details again show the tags their contents already use
  (aggregated, muted `inside (n)` chips that filter the grid).

## [0.3.0] — 2026-09-20

Rebrand + polish release. "Asset Vault" is now **Poly Vault**.

### Added

- **Rebrand** — new product name, logo, and app icons (`build/icon.ico|png|icns`).
  Existing libraries, tags, and descriptions are migrated automatically on
  first launch.
- **Three themes** — Default (brand dark), Dark (true near-black), and a new
  readable Light theme, switchable from the toolbar and remembered per user.
- **Montserrat typography** — the font family is bundled offline with the app
  (no network fetch), weights 300–700. *(Replaced by Inter in the 0.4 bento
  refresh.)*
- **Tag filtering** — a Tags dropdown in the toolbar lists every tag with its
  asset count; selecting tags AND-filters the grid, mirrored by live chips and
  an active-filter badge.
- **Live Unity connection indicator** — top-right chip shows
  *unity: connected* while the Unity Editor plugin is actively polling the
  bridge.
- **Horizontal wordmark** — taller, crisper toolbar logo (overrides the square
  mark), with a dark chip behind it on the Light theme.
- **Automated release builds** — GitHub Actions workflow builds Windows, Linux,
  and macOS installers on `v*` tags and uploads them as artifacts.

### Changed

- **No-refresh card selection** — clicking an asset card only highlights it and
  updates the details panel; the grid is no longer rebuilt, eliminating the
  flicker and repeated entrance animations.
- **Diff-skip refresh** — the renderer skips repaints entirely when a rescan
  returns unchanged data (jobs / libraries).
- **Menu bar removed** — the default File/Edit/View/Window menu no longer
  appears (`Menu.setApplicationMenu(null)`).
- Top-left brand is now the horizontal logo image only; text removed.

### Fixed

- Light-theme contrast for readable text and controls.
- Blurry, small toolbar logo (crisper 640 px-tall asset, larger display size).
- ICO generation now produces a classic multi-size BMP ICO accepted by
  electron-builder (was rejected as an invalid ICO).

## [0.2.0] — earlier

Initial "Asset Vault" releases: library scanner, preview cards, tree browser,
detail panel, tags & descriptions, Unity 6 bridge plugin with basic job queue,
Windows installer packaging, smoke/e2e test harness.

---

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org).
Versions before 0.3.0 shipped under the product name "Asset Vault".