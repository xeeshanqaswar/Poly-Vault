# LinkedIn post — v0.4.0

---

0.4.0 is out, and it's the release that removes the most boring part of the
whole app.

Until now, tagging and describing an asset meant clicking *Fetch from store*,
one asset at a time. In 0.4.0 that's gone. Point Poly Vault at your asset
folders and walk away: the main process looks each new asset up in the Unity
Asset Store in the background (throttled, deduplicated, cancellable), saves the
description, and derives tags from the store name, category and description
text. You come back to a library that's already organised.

**Update** (which replaces *Rescan*) works the same way — it matches your
selection. An asset updates that asset. A folder updates its subtree. A library
updates the whole library. Nothing selected means everything. Store failures are
retried in the background and always report a reason, so nothing fails silently
any more.

Also in this release:

- One tag editor for assets, folders *and* libraries, with a *cascade to n
  items* toggle — tag a folder once and the whole subtree follows.
- Descriptions edit in place, and text you write by hand is never overwritten by
  a lookup that finds nothing.
- The details panel got quieter: *Import files* lists only `.unitypackage`
  files, and the footer is just the full-width *Open folder* button.
- Visual refresh: hairline cards on soft ambient gradients, Inter typography,
  lucide icons throughout.

Installers for Windows, Linux (AppImage + deb) and macOS (Apple Silicon +
Intel), plus the Unity 6 UPM package — all in the release:
https://github.com/xeeshanqaswar/Poly-Vault/releases/tag/v0.4.0

Still free, still MIT, still fully offline — your library is never modified, and
imports are copies into `Assets/PolyVaultImports/`.

If your tagging workflow still involves a spreadsheet, this one is for you.
Feedback welcome, especially on where the auto-tags get it wrong.

#PolyVault #Unity #GameDev #IndieDev #OpenSource #AssetManagement

---
