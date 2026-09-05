---
title: Development setup
description: Install the Control Room toolchain, run checks, and build the Windows installer.
---

Control Room is a Tauri 2 app with a React and TypeScript frontend, a Rust backend, SQLite, xterm, Windows OpenSSH, and ConPTY.

## Prerequisites

- Windows 11 x64
- Node.js 22 or newer
- Rust stable with the MSVC target
- Visual Studio C++ Build Tools and the Windows SDK
- WebView2 Runtime
- the Windows OpenSSH Client optional feature

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

## Build the installer

```bash
npm run tauri build
```

The build creates an unsigned per-user NSIS installer under `src-tauri/target/release/bundle/nsis/`.

## Work on the documentation site

The docs site lives under `docs/` and is a separate Astro project:

```bash
cd docs
npm install
npm run dev
```

Build and type-check it with:

```bash
npm run build
```

Starlight indexes the Markdown pages with its built-in Pagefind search during the production build.
