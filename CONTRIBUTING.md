# Contributing

Thanks for taking the time to contribute to **Poly Vault**. This is a friendly,
small project — questions, bug reports, feature ideas, and pull requests are
all welcome.

## Ground rules

- **Be kind.** This is an open source project written by one person. Assume
  good faith from everyone.
- **One change per PR.** Small, focused pull requests are much easier to
  review than a bundle of unrelated edits.
- **Keep the tests green.** `npm run smoke` and `npm run e2e` must pass before
  a merge (see below).
- **Match the code style.** The codebase avoids framework dependencies and
  keeps the renderer dependency-free; follow the existing conventions in the
  file you touch. Do not add inline comments unless they explain a genuinely
  non-obvious decision.
- **No secrets.** Never commit tokens, certificates, or private data.

## Getting started

```powershell
npm install
npm start          # run the app (dev)
```

Requirements: [Node.js](https://nodejs.org) 20+ (tested on 24 LTS).

### Running the test suite

```powershell
npm run smoke      # headless scanner + bridge test (no window)
npm run e2e        # boots the real app with a fixture library, checks the UI
```

The e2e test spawns the packaged/dev Electron app with isolated data folders
via `ASSETVAULT_USER_DATA` and `ASSETVAULT_BOOT_LIBRARY`, so it will never
touch your real libraries. Both tests must pass before you submit a PR.

### Regenerating assets (only when branding/artwork changed)

```powershell
npm run icons      # build/icon.* + ui/assets/logo.png + Montserrat woff2
```

## Reporting bugs

Open an issue with:

- OS and version (Windows/Linux/macOS).
- Poly Vault version (from `dist` installer name or `package.json`).
- Steps to reproduce.
- If relevant, the library folder layout that triggers the problem
  (paths can be trimmed).

## Feature ideas

Check `docs/SPECIFICATION.md` and `docs/TECHNICAL.md` first — the requested
behavior may already exist and just needs a fix, or may already be on the
roadmap. Discuss larger features in an issue *before* writing lots of code.

## Submitting changes

1. Fork the repository and create a feature branch.
2. Make your change, keeping it scoped.
3. Run `npm run smoke` and `npm run e2e`.
4. Commit with a concise message describing *why* (match existing history
   style).
5. Open a pull request referencing any related issue.

## Maintainers

- **Zeeshan Qaswar** — author and current maintainer.