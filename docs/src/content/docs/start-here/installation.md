---
title: Installation
description: Install the current Windows release of Control Room.
---

Control Room ships as an unsigned, per-user NSIS installer for Windows 11 x64.

## Download a release

1. Open the [latest GitHub release](https://github.com/YounesCodes/control-room/releases/latest).
2. Download the `.exe` installer and its SHA-256 checksum.
3. Verify the checksum if you want to check the file before running it.
4. Run the installer for your Windows user.

The installer does not require administrator access. Windows may show an unrecognized-publisher warning because the release is unsigned.

## After installation

Start Control Room from the Start menu or its installed shortcut. The first screen opens with no Saved Connections. Select **Add connection** to create one.

See [Quick start](/control-room/start-here/quick-start/) for the first connection and [Connections](/control-room/connections/) for all connection fields.

## Build from source

For development builds, use the [development setup](/control-room/development/setup/) page. Source builds need the Windows toolchain as well as Node.js and Rust.
