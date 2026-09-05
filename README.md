# Control Room

> A Windows SSH client with read-only Linux host inspection.

[![Latest release](https://img.shields.io/github/v/release/YounesCodes/control-room?display_name=tag)](https://github.com/YounesCodes/control-room/releases/latest) [![CI](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml)

Control Room is a local Windows desktop app for working with Linux machines over SSH. It keeps a real interactive terminal beside bounded, read-only views of the same Remote Host.

## Documentation

Read the [Control Room documentation](https://younescodes.github.io/control-room/) for installation, first connection, terminal and Workspace usage, host inspection, security, troubleshooting, and development.

## What it includes

- Interactive SSH terminals backed by the Windows OpenSSH client and ConPTY.
- Multiple remote Workspaces, terminal tabs, splits, and focus mode.
- Local terminal Workspaces for installed PowerShell 7, Windows PowerShell, Command Prompt, and Git Bash.
- Read-only views for host capabilities, systemd units, listening ports, Docker, boot evidence, and logs.
- Explicit Host Baselines with normalized facts and deterministic comparisons.
- Optional, reversible Bash Enhanced History for remote sessions.
- Local Connection Groups, tags, settings, and plain-text Scratchpad notes.

Structured views do not edit remote files, transfer files, manage services or containers, install packages, scan networks, or run a monitoring agent. The terminal is the place to perform administrative work.

## Support

| Area | Support |
| --- | --- |
| Local machine | Windows 11 x64 |
| SSH | The Windows OpenSSH Client already installed |
| Structured remote inspection | Debian or Ubuntu family Linux with systemd, journald, Bash, and `ss` from iproute2 |
| Docker | Optional Docker installation on the Remote Host |
| Other Linux hosts | Terminal-only, best effort |

## Install

Download the latest unsigned, per-user NSIS installer from [GitHub Releases](https://github.com/YounesCodes/control-room/releases/latest). A SHA-256 checksum is published beside each installer. Windows may show an unrecognized-publisher warning.

After starting the app, select **Add connection**, enter the SSH destination and username, then save the connection. [Quick start](https://younescodes.github.io/control-room/start-here/quick-start/) explains the first structured access test.

## Development

Prerequisites:

- Windows 11 x64
- Node.js 22 or newer
- Rust stable with the MSVC target
- Visual Studio C++ Build Tools, Windows SDK, and WebView2
- Windows OpenSSH Client

```bash
npm ci
npm run tauri dev
npm run check
npm run tauri build
```

The installer is produced under `src-tauri/target/release/bundle/nsis/`. Live SSH tests are ignored by default and require a host and account you control.

The documentation site is a separate Astro Starlight project under `docs/`:

```bash
cd docs
npm install
npm run dev
npm run build
```

See the [contributing guide](https://younescodes.github.io/control-room/development/contributing/) before changing product behavior. Keep `AGENTS.md` and `DESIGN.md` current, and do not commit or push changes without an explicit request.
