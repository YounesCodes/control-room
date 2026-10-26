# Control Room

> A Windows and macOS SSH client with read-only Linux, Windows, and macOS host inspection.

[![Latest release](https://img.shields.io/github/v/release/YounesCodes/control-room?display_name=tag)](https://github.com/YounesCodes/control-room/releases/latest) [![CI](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml)

Control Room gives you one place to work with Linux, Windows, and macOS machines over SSH. Save each host once and open it as a Workspace. Inspect services, ports, containers, and logs where supported. Mac hosts offer zsh, Bash, and installed fish shells, launchd services, native ports and connections, unified logs, boot records, baselines, and optional Bash/zsh command history. Docker uses the account's selected context. Windows 10 and 11 hosts offer installed shells, supported Windows Terminal profiles, and WSL distributions before connecting, with Windows services, ports, resource readings, and Docker inspection when available.

- A real terminal with tabs and splits. It runs through your system OpenSSH client and native terminal processes, so your existing keys, `~/.ssh/config`, and ssh-agent keep working.
- Saved connections with groups and tags, and several Workspaces per host.
- Read-only views for systemd units, listening ports, Docker containers, logs, boot evidence, and baselines you can compare over time.
- Local PowerShell, Command Prompt, and Git Bash on Windows, or zsh, Bash, and fish on macOS. Windows also offers administrator terminals.
- Signed in-app updates: Control Room can update itself from inside the app.

## Install

Download the latest installer:
[GitHub Releases](https://github.com/YounesCodes/control-room/releases/latest)

Runs on Windows 11 x64 and installs for your user without administrator access.

_Note that Windows may warn that the publisher is unsigned._

The macOS port supports Intel and Apple Silicon and is awaiting hands-on testing before release. Build it on a Mac with Node.js 22.22.2 or newer, Rust stable, and the Xcode Command Line Tools:

```sh
npm ci
npm run tauri build
```

Open `src-tauri/target/release/bundle/macos/Control Room.app`, or install the DMG from `bundle/dmg/`. Pull request CI also produces separate Intel and Apple Silicon test bundles. These use ad-hoc signing; public signed and notarized Mac releases require Apple Developer credentials.

## Documentation

**[Quick start](https://younescodes.github.io/control-room/start-here/quick-start/)**
