---
title: Development
description: Build Control Room from source, run the validation gate, and produce the Windows installer.
---

Control Room is a Tauri 2 app. A React and TypeScript frontend renders the interface, and a Rust backend owns native processes, SQLite, SSH argument construction, remote command construction, and local shell discovery. The frontend never receives a way to run an arbitrary command.

## Prerequisites

- Windows 11 x64
- Node.js 22 or newer
- Rust stable with the MSVC target
- Visual Studio C++ Build Tools and the Windows SDK
- WebView2 Runtime
- The Windows OpenSSH Client optional feature

## Run the app

From the repository root:

```bash
npm ci
npm run tauri dev
```

## Run the validation gate

```bash
npm run check
```

The check verifies synchronized versions, formatting, ESLint, frontend tests and build, Rust formatting, Clippy, and Rust tests. Live SSH tests are ignored by default and need a host and account you control.

Neither development nor the validation gate needs the updater signing key. Signed updater artifacts are produced only by the release workflow.

## Build the installer

```bash
npm run tauri build
```

The build creates an unsigned per-user NSIS installer under `src-tauri/target/release/bundle/nsis/`.

## Work on the documentation site

The docs site lives under `docs/` and is a separate Astro project:

```bash
cd docs
npm ci
npm run dev
```

`npm run build` type-checks and builds the static site, including the Pagefind search index.

## Releases

Release tags use the `v*` pattern, and the tagged version must match the versions in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`. The release workflow builds the installer, signs the updater artifact with a key held in repository secrets, publishes the SHA-256 checksum beside it, and writes the `latest.json` feed that the in-app updater reads. A release the updater could not verify is treated as a failed release.
