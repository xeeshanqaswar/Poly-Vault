# AGENTS.md

Guardrails and runbooks for working in the **Poly Vault** repository.

Project: Poly Vault · offline-first desktop asset manager (Electron) with a
Unity 6 bridge plugin. Maintainer: **Zeeshan Qaswar**. Repo:
<https://github.com/xeeshanqaswar/Poly-Vault>.

The most important job here is **publishing a new version end-to-end without
being asked twice** — follow the runbook in [Publishing a new version](#publishing-a-new-version).

---

## Environment (Windows)

- OS is Windows; shell is **PowerShell 5.1**.
- **Always refresh PATH** at the start of every command:
  `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")`
- Use `npm.cmd` (PowerShell blocks `npm.ps1`). Spawn binaries directly:
  `node_modules/electron/dist/electron.exe` (dev) and `dist\win-unpacked\Poly Vault.exe` (packaged).
- The app binds **127.0.0.1:7100**. Before any app test, build, or e2e that touches the bridge,
  kill stale instances:
  `taskkill /IM "Poly Vault.exe" /F 2>$null; taskkill /IM electron.exe /F 2>$null; Start-Sleep -Seconds 3`
  (a stale instance sitting on 7100 makes smoke/e2e fail with `EADDRINUSE`).
- Test/dev hooks: `ASSETVAULT_USER_DATA` (isolated data), `ASSETVAULT_BOOT_LIBRARY` (register a
  library at boot), `ASSETVAULT_DEBUG` (renderer console to stdout).
- Working directory moved to **`E:\Poly Vault`** (2026-09-20). Never assume a different root.

### GitHub automation (no `gh` CLI is installed)

Get the cached token from Windows Credential Manager and use it as a bearer token for
`api.github.com` / `uploads.github.com`:

```powershell
$cred = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
$tok  = ($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=',''
$h    = @{ Authorization = "token $tok"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'poly-vault-rel' }
```

- **Upload release assets with `curl.exe` only.** PowerShell `Invoke-RestMethod` is rejected by
  `uploads.github.com` with HTTP 400. Pattern:
  `curl.exe -sS -X POST -H "Authorization: token $tok" -H "Content-Type: application/octet-stream" --data-binary "@<file>" "https://uploads.github.com/repos/xeeshanqaswar/Poly-Vault/releases/<id>/assets?name=<urlencoded name>"`
- API query examples seen working: PATCH `/repos/...` (description/topics), POST `/releases`,
  GET `/actions/runs`, GET `/actions/runs/<id>/artifacts`, GET `/actions/artifacts/<id>/zip`,
  POST `/actions/workflows/build.yml/dispatches`.

---

## Repo map (quick)

| Path | Contents |
| --- | --- |
| `src/main/index.js` | Electron main: window, IPC, dialogs, user-data migration, `__diag` probe |
| `src/main/library.js` | Scanner: asset/container detection, aggregation, kind bucketing |
| `src/main/bridgeServer.js` | HTTP bridge `:7100`, job queue, guards, Unity routes, `unitySeenAt` |
| `src/main/store.js` | JSON-backed persistence (no Electron deps) |
| `src/preload.js` | Context-isolated `contextBridge` IPC surface |
| `ui/` | Renderer SPA — `index.html`, `style.css`, `renderer.js` (no framework) |
| `unity-plugin/PolyVault/` | UPM Editor package `com.polyvault.bridge` (Unity 6000.0), UPM + `Editor/AssetVault*.cs` |
| `tools/` | `gen-icon.js`/`gen-fonts.js` (`npm run icons`), `analyze-brand.js`, `png.js` |
| `tests/smoke.js`, `tests/e2e.js` | Headless scanner/bridge test and full-app UI test |
| `docs/SPECIFICATION.md` | Product spec — capabilities, API contracts, behaviours |
| `docs/TECHNICAL.md` | Implementation guide — architecture, storage, packaging |
| `CHANGELOG.md`, `CONTRIBUTING.md`, `README.md` | Standard project docs |

Detailed docs live in `docs/SPECIFICATION.md` and `docs/TECHNICAL.md`; read the relevant section
before making changes.

---

## Conventions

- **No inline comments** unless a decision is genuinely non-obvious.
- Renderer stays dependency-free; theming is `data-theme` + CSS custom properties; fonts are the
  bundled Montserrat woff2 files.
- **Keep internal identifiers stable**: IPC channels `assetvault:*`, storage file names
  (`asset-vault-*.json`), ignore markers (`.assetvault-ignore`/`.nomedia`), C# `AssetVault.*`
  classes, internal temp prefixes.
- Exactly **three** themes: `default`, `dark`, `light`. `localStorage av.theme` wins, else default.
- Do **not** commit: `node_modules/`, `dist/`, `out/`, `.release/`, `build/icon.ico`, `build/icon.png`, `*.log`.
- Tests are the gate: `node tests\smoke.js` and `node tests\e2e.js` must pass before any release.
- Branch: `main` only. Global git identity is already configured.

---

## Publishing a new version

Executable runbook — do all of this in order without asking (confirming the version number is the
only thing worth a question).

1. **Bump the version** (e.g. `0.3.0 → 0.4.0`) in:
   - `package.json` → `version`
   - `package-lock.json` → top-level `version` **and** `packages[""].version`
   - `unity-plugin/PolyVault/package.json` → `version` (keep in lockstep with the app)

2. **Update `CHANGELOG.md`** — add a new `[x.y.z] — <date>` section (Keep a Changelog format)
   above the previous release, carrying over any still-open `[Unreleased]` notes.

3. **Update version references** in `README.md` (installer table, version badge) and any `docs/`
   mentions of the old version.

4. **Regenerate assets**: `npm.cmd run icons`

5. **Verify**: `node tests\smoke.js` then `node tests\e2e.js` (kill stale apps on 7100 first).

6. **Build the Windows installer** locally: `npm.cmd run dist` → `dist\PolyVault-Setup-<ver>.exe` + `.blockmap`.

7. **Build the Unity package artifacts** (staging in `.release/`, which is gitignored):
   ```powershell
   New-Item -ItemType Directory -Path .release -Force | Out-Null
   npm.cmd pack ./unity-plugin/PolyVault --pack-destination .release
   Copy-Item .release\com.polyvault.bridge-<ver>.tgz .release\PolyVault-Unity-<ver>.tgz
   Compress-Archive -Path unity-plugin\PolyVault -DestinationPath .release\PolyVault-Unity-<ver>.zip -Force
   ```

8. **Commit** with a conventional message (e.g. `chore: release v<ver>`) and push `main`.

9. **Tag and push** (triggers the CI installers workflow `v*`):
   ```powershell
   git tag -a v<ver> -m "Poly Vault <ver>"
   git push origin v<ver>
   ```

10. **Wait for CI.** Poll
    `GET /repos/xeeshanqaswar/Poly-Vault/actions/runs?event=push&per_page=5` until the run for the
    new tag reaches `conclusion: success` (all three OS jobs must succeed). If CI is broken, fix it
    (check `npm ci` / icons / smoke / build steps via the run logs) and re-run by pushing a new tag —
    or by dispatch: `POST /actions/workflows/build.yml/dispatches` with `{"ref":"main"}`.
    The workflow passes `--publish never`; it only **uploads artifacts**, it must never publish.

11. **Create the GitHub release** for tag `v<ver>` via `POST /repos/xeeshanqaswar/Poly-Vault/releases`
    (`tag_name`, `target_commitish: main`, `draft: false`, `prerelease: false`) with release notes:
    highlights, install notes (unsigned/SmartScreen, macOS gatekeeper, Linux perms), and a link to
    the docs.

12. **Upload assets** to the release with `curl.exe` (see token pattern above):
    - local: `dist\PolyVault-Setup-<ver>.exe`, `dist\PolyVault-Setup-<ver>.exe.blockmap`,
      `.release\PolyVault-Unity-<ver>.tgz`, `.release\PolyVault-Unity-<ver>.zip`
    - from CI artifacts (download via artifacts API, expand, then upload):
      `PolyVault-<ver>-x86_64.AppImage`, `PolyVault-<ver>-amd64.deb`,
      `PolyVault-<ver>-x64.dmg`, `PolyVault-<ver>-arm64.dmg`,
      `PolyVault-<ver>-x64.zip`, `PolyVault-<ver>-arm64.zip`

13. **Verify** the release lists every asset (`GET /releases/tags/v<ver>` → `assets[]`), then report
    the release URL.

**Version-sensitive files to double-check after bumping:** `package.json`, `package-lock.json`,
`unity-plugin/PolyVault/package.json`, `README.md`, `docs/SPECIFICATION.md`,
`docs/TECHNICAL.md`, `CHANGELOG.md`.

---

## Windows packaging notes

- Icons come from `branding/` via `npm run icons` (`build/icon.ico|png|icns`, `ui/assets/*`).
- Linux `deb` artifact is `PolyVault-<ver>-amd64.deb` (Debian amd64 naming), AppImage is
  `PolyVault-<ver>-x86_64.AppImage`.
- macOS DMG/zip are unsigned (`identity: null`); producing them requires a Mac — CI covers this.
- AppImage cannot be built on Windows (`mksquashfs` missing) — always use CI for Linux/macOS.