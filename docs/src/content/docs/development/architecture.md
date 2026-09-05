---
title: Architecture
description: The boundaries between the Tauri shell, Rust backend, frontend, and remote host.
---

## Runtime shape

The desktop app has four important layers:

| Layer | Responsibility |
| --- | --- |
| Tauri | Owns the Windows desktop window and native app lifecycle. |
| Rust | Owns native processes, SQLite, SSH arguments, remote commands, local shell discovery, pty lifecycle, bounds, and permission handling. |
| React and TypeScript | Renders Workspaces and views, keeps view state, and calls typed Tauri commands. |
| Remote Host | Answers bounded, read-only SSH operations or hosts the interactive shell. |

## One session lifecycle

SSH and local sessions share the `SessionManager` lifecycle through portable-pty: one reader thread, one flow-control path, one writer, resize, and kill behavior. SSH-specific behavior stays out of local sessions. Local shells never borrow a Saved Connection or reach the machine through SSH.

The frontend names only a validated Local Shell Profile id. Rust resolves its executable, fixed arguments, and working directory. There is no `run_command` API that accepts a program, script, or argument list from React.

## Remote operations

Structured operations run separately from Terminal Sessions. The backend builds the bounded command, applies a timeout and per-connection limiter, handles optional read-only elevation, parses typed facts, and returns structured data rather than raw command output.

Examples include:

- systemd unit listing through `systemctl show`
- host load from `/proc`
- listener snapshots from `ss`
- Docker list and single-container inspection
- boot evidence from journald and systemd tools
- normalized baseline sections

## Data boundaries

SQLite stores connection metadata, settings, Workspace layout, cached capabilities, Enhanced History when enabled, Scratchpad notes, and normalized baselines. It does not store terminal output, logs, passwords, private keys, or boot evidence.

Each Saved Connection, Workspace, Terminal Session, Structured Operation, and Log Stream has its own identity and lifecycle. Log streams, live load samples, container details, and boot diagnostics remain in memory.
