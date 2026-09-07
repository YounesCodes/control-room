# Control Room

> A Windows and macOS SSH client with read-only Linux host inspection.

[![Latest release](https://img.shields.io/github/v/release/YounesCodes/control-room?display_name=tag)](https://github.com/YounesCodes/control-room/releases/latest) [![CI](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml)

Control Room gives you one place to keep and work with your Linux machines from Windows or macOS. Save each host once, open it as a Workspace, and get a real SSH terminal next to views of that machine's services, containers, ports, and logs.

- A real terminal with tabs and splits. It runs through the system OpenSSH client and native PTY already on your machine, so your existing keys, SSH config, and ssh-agent keep working.
- Saved connections with groups and tags, and several Workspaces per host.
- Read-only views for systemd units, listening ports, Docker containers, logs, boot evidence, and baselines you can compare over time.
- Local terminals for PowerShell, Command Prompt, and Git Bash on Windows, or zsh, Bash, and fish on macOS.
- Signed in-app updates: Control Room checks GitHub Releases, downloads only when you ask, and installs after a restart you confirm.

The views report. The terminal is where you act.

## Install

Download the latest package from [GitHub Releases](https://github.com/YounesCodes/control-room/releases/latest). Control Room supports Windows 11 x64 and macOS 12 or later on Apple silicon. Releases include a per-user Windows installer and a signed, notarized macOS disk image. SHA-256 checksums are published beside both.

Control Room can update itself from inside the app, but only from a version that already has the updater. v0.6.1 and earlier predate it, so upgrading from one of those means running the newer installer from GitHub Releases once, by hand. Every later release can update from inside the app.

Start the app, select **Add connection**, enter your host and username, and save. The [Quick start](https://younescodes.github.io/control-room/start-here/quick-start/) walks through the first connection step by step.

## Documentation

The full manual lives at [younescodes.github.io/control-room](https://younescodes.github.io/control-room/): installation, the first connection, terminals and Workspaces, host inspection, security, and troubleshooting.
