# Control Room

> A Windows and Linux SSH client with read-only Linux and Windows host inspection.

[![Latest release](https://img.shields.io/github/v/release/YounesCodes/control-room?display_name=tag)](https://github.com/YounesCodes/control-room/releases/latest) [![CI](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml)

Control Room gives you one place to work with Linux and Windows machines over SSH. Save each host once and open it as a Workspace. Inspect services, ports, containers, and logs where supported. Windows 10 and 11 hosts offer installed shells, supported Windows Terminal profiles, and WSL distributions before connecting, with Windows services, ports, resource readings, and Docker inspection when available.

- A real terminal with tabs and splits. It uses your system OpenSSH client, with your existing keys, `~/.ssh/config`, and ssh-agent.
- Saved connections with groups and tags, and several Workspaces per host.
- Read-only views for systemd units, listening ports, Docker containers, and logs.
- Local terminals for installed shells, with administrator PowerShell and Command Prompt on supported Windows systems.
- Signed in-app updates for the Windows installer and Linux AppImage.

## Install

Download the latest installer:
[GitHub Releases](https://github.com/YounesCodes/control-room/releases/latest)

- **Windows 11 x64.** Run the `.exe` installer for your user. Windows may show an unsigned publisher warning.
- **Ubuntu 24.04 LTS x86_64.** Install the `.deb` with `sudo apt install ./<filename>.deb`, or make the AppImage executable and run it. Other Debian-based desktops may work with compatible libraries.

See [Install and update](https://younescodes.github.io/control-room/start-here/installation/) for dependencies and update instructions.

## Documentation

**[Quick start](https://younescodes.github.io/control-room/start-here/quick-start/)**
