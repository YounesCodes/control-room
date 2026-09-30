# Control Room

> A Windows SSH client with read-only Linux host inspection.

[![Latest release](https://img.shields.io/github/v/release/YounesCodes/control-room?display_name=tag)](https://github.com/YounesCodes/control-room/releases/latest) [![CI](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml)

Control Room gives you one place to keep and work with your Linux machines from Windows. Save each host once, open it as a Workspace, and get a real SSH terminal next to views of that machine's services, containers, ports, and logs.

- A real terminal with tabs and splits. It runs through the Windows OpenSSH client and ConPTY already on your machine, so your existing keys, `~/.ssh/config`, and ssh-agent keep working.
- Saved connections with groups and tags, and several Workspaces per host.
- Read-only views for systemd units, listening ports, Docker containers, logs, boot evidence, and baselines you can compare over time.
- Local terminals available, including administrator PowerShell and Command Prompt sessions.
- Signed in-app updates: Control Room can update itself from inside the app.

## Install

Download the latest installer:
[GitHub Releases](https://github.com/YounesCodes/control-room/releases/latest)

Runs on Windows 11 x64 and installs for your user without administrator access.

_Note that Windows may warn that the publisher is unsigned._

## Documentation

**[Quick start](https://younescodes.github.io/control-room/start-here/quick-start/)**
