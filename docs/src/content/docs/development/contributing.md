---
title: Contributing
description: Keep changes within Control Room's product and safety boundaries.
---

Start with the repository's `AGENTS.md` and `DESIGN.md`. They define the supported platforms, terminology, visual system, remote-read boundary, and data rules.

## Before opening a change

1. Read the relevant frontend and Rust implementation instead of inferring behavior from labels.
2. Keep remote operations bounded and read-only.
3. Add parser, argument-builder, lifecycle, and regression tests when behavior changes.
4. Keep README.md, DESIGN.md, and AGENTS.md current when the product changes.
5. Check local and remote behavior separately. A Local Workspace is terminal-only.

## Validate the app

```bash
npm ci
npm run check
npm run tauri build
```

Live SSH tests are ignored by default. Run them only with a host and account you control.

## Validate the docs

```bash
cd docs
npm install
npm run build
```

The docs build runs `astro check` before generating the static site. Check internal links, the base path, search, the 404 page, light and dark themes, and narrow screens before publishing.

## Keep the scope clear

Do not add file transfer, remote editing, service or container management, cloud accounts, collaboration, AI features, mobile support, host discovery, background monitoring, package updates, private-key storage, or local machine inspection. If a proposal needs one of those, discuss the product boundary before writing code.
