# Changelog

All notable changes to **Poly Vault** are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com) and this project adheres to
[Semantic Versioning](https://semver.org).

## [0.3.0] — 2026-09-20

Rebrand + polish release. "Asset Vault" is now **Poly Vault**.

### Added

- **Rebrand** — new product name, logo, and app icons (`build/icon.ico|png|icns`).
  Existing libraries, tags, and descriptions are migrated automatically on
  first launch.
- **Three themes** — Default (brand dark), Dark (true near-black), and a new
  readable Light theme, switchable from the toolbar and remembered per user.
- **Montserrat typography** — the font family is bundled offline with the app
  (no network fetch), weights 300–700.
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