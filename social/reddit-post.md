# Reddit post — v0.4.0

---

**Title:**

v0.4.0: my Unity asset manager now auto-describes and auto-tags every new asset
from the Asset Store (open source, MIT, offline)

**Body:**

Reposting an update to a tool I built for the "thousands of asset folders across
multiple drives" life — **Poly Vault**. This release finally removes the manual
step I hated most.

**What changed in 0.4.0**

- **Automatic store enrichment.** Every newly discovered asset is looked up in
  the Unity Asset Store by the main process — throttled, deduplicated, retried in
  the background on failure. The description is saved and tags are derived from
  the store name, category and description text. There is no *Fetch from store*
  button anymore.
- **Update replaces Rescan**, and it is scoped to your selection: an asset
  updates itself, a folder updates its subtree, a library updates the whole
  library, nothing selected updates everything. You get a progress bubble while
  the queue drains, and every failure tells you the actual reason.
- **One tag editor for assets, folders and libraries.** Removable chips, inline
  suggestions from tags already in the app, and a *cascade to n items* toggle
  (on by default for folders/libraries) so tagging a folder once tags the
  subtree. Folders and libraries also list the tags their contents already use,
  and those aggregate `inside (n)` chips are clickable filters.
- **Details panel cleanup.** Descriptions edit in place, text you wrote by hand
  is never overwritten by a lookup that finds nothing, *Import files* lists only
  the `.unitypackage` files by name, and the footer is just *Open folder*.
- **Visual refresh**: hairline cards on soft ambient gradients, Inter instead of
  Montserrat, lucide icons throughout, consistent 8px spacing scale.

**What it already did (v0.3.0 and earlier)**

- Folder tree + preview-card grid for meshes, textures, audio, materials, fonts,
  scripts
- Tag filtering (AND) and search
- Per-folder stats: asset counts, file counts, sizes, detected asset kinds
- One-click import into Unity 6: queue a job in the app and the bundled UPM
  package copies it into `Assets/PolyVaultImports/…` — copies only, your library
  is never modified or deleted
- `preview.png` thumbnails, `.assetvault-ignore` markers, 3 themes, live "Unity
  connected" indicator
- Fully offline: loopback-only local server, no accounts, no telemetry

**Install (v0.4.0)**

- Windows: `PolyVault-Setup-0.4.0.exe`
- Linux: `PolyVault-0.4.0-x86_64.AppImage` or `PolyVault-0.4.0-amd64.deb`
- macOS: `PolyVault-0.4.0-arm64.dmg` (Apple Silicon) or `PolyVault-0.4.0-x64.dmg`
- Unity 6 package: `PolyVault-Unity-0.4.0.tgz` (UPM) or `.zip`

https://github.com/xeeshanqaswar/Poly-Vault/releases/tag/v0.4.0

Source is MIT, Electron + vanilla JS, no framework, JSON storage. Windows build
is unsigned (SmartScreen → *More info → Run anyway*); macOS build is unsigned
for now (right-click → *Open*), Apple signing is wired up in CI and activates
when credentials are added.

Two questions for you since I'm the one guessing: does the auto-tagging get the
labels *right* for your library, or do you end up renaming half of them? And
would you rather have a confidence threshold (only tag when the store match is
strong) or raw auto-tags with an easy undo? Folder watching is next on my list
after that.

---
