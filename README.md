# Control Room

> A Windows SSH client with read-only Linux and Windows host inspection.

[![Latest release](https://img.shields.io/github/v/release/YounesCodes/control-room?display_name=tag)](https://github.com/YounesCodes/control-room/releases/latest) [![CI](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml)

Control Room gives you one place to work with Linux and Windows machines over SSH. Save each host once and open it as a Workspace. Inspect services, ports, containers, and logs where supported. Windows 10 and 11 hosts offer installed shells, supported Windows Terminal profiles, and WSL distributions before connecting, with Windows services, ports, resource readings, and Docker inspection when available.

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

## Release

Create a GitHub draft release for the next `vX.Y.Z` tag and write its release notes in the draft body before pushing the tag. Keep the release as a draft. The tag workflow builds the app, copies the GitHub body into `latest.json`, verifies that the notes match, and publishes the release. Release notes do not need a file or commit in this repository.
