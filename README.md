# Control Room

> A Windows SSH client with read-only Linux host inspection.

[![Latest release](https://img.shields.io/github/v/release/YounesCodes/control-room?display_name=tag)](https://github.com/YounesCodes/control-room/releases/latest) [![CI](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml)

Control Room is a local Windows desktop application for working with Linux machines over SSH. It gives you a real interactive shell and a set of bounded, read-only views for the same Remote Host: system details, systemd services, journald, Docker containers, logs, and opt-in Bash command history.

It is for people who manage Linux machines from Windows and want host context close to their terminal work. Control Room is not a monitoring service, RMM tool, server control panel, web dashboard, cloud platform, SSH replacement, or AI tool. The terminal remains the place where you perform administrative work.

## What the app looks like

The main window has a Connections rail on the left, Workspace tabs across the top, and a main pane that changes between Terminal, Overview, Services, Docker, Logs, and Enhanced History. A Workspace belongs to one Saved Connection. You can open several Workspaces, including several for the same connection, then focus or split terminal sessions when you need to compare hosts.

## Why Control Room?

A normal Windows terminal gives you a shell after you run `ssh`. You then type the inspection commands yourself and keep the results in a scrollback buffer.

Control Room keeps that shell, then adds a small set of structured views around the same connection:

```text
Saved Connection
    |
    +-- Workspace
         +-- Interactive SSH terminal
         +-- Host overview
         +-- systemd services
         +-- Docker containers
         +-- journald and Docker logs
         +-- Enhanced History, when enabled
```

The distinction matters. Control Room helps you inspect and move between related views. It does not try to replace OpenSSH or turn a local desktop client into a remote administration platform.

## Features

### Workspaces and SSH

- Save an SSH destination, required username, and optional port or existing identity-file override as a Saved Connection.
- Open multiple independent Workspaces and multiple Terminal Sessions for one Saved Connection.
- Use an interactive terminal backed by the Windows OpenSSH client and ConPTY, with resizing, scrollback, Unicode, ANSI and VT output, copy and paste, and control keys.
- Reconnect a dropped Terminal Session, clear its local display, or focus and split terminal panes.
- Restore Workspace tabs and layout after restarting the app. Restored Workspaces start disconnected and never reconnect automatically.

### Host inspection

- View the hostname, operating system, kernel, architecture, uptime, default shell, and detected runtime capabilities.
- List systemd service units, search them, inspect their state, and open their journal logs.
- List Docker containers, search by name or image, inspect their state, and open their logs.
- Reuse recent inspection results briefly and refresh them manually when you need current data.

All structured inspection is read-only. Control Room does not start, stop, restart, create, or remove services or containers.

### Logs

- Read journald output for a selected systemd service or Docker output for a selected container.
- Choose a tail size, follow a live stream, pause or resume rendering, stop a stream, and clear the view.
- Search the lines already loaded in the current view.
- Keep each Log Stream independent and in memory. Control Room does not persist fetched logs.

### Enhanced History

Enhanced History is an opt-in Bash integration, not an import of the remote account's existing shell history.

When enabled, Control Room installs a marked block in the remote account's `~/.bashrc` and a script under `~/.local/share/control-room/`. Integrated Bash sessions report the command, working directory, timestamps, and exit code back to Control Room. The app records those entries locally, where you can search, copy, paste, delete, clear, pause, disable, or remove the integration.

Capture starts only in sessions opened after you enable it. Control Room does not infer commands from keystrokes or read `.bash_history`. Command lines may contain secrets, so enable this only when that local record is appropriate for your work.

### Productivity

- Search Saved Connections from the sidebar.
- Use the command palette to open connections, switch views, change Workspaces, reconnect, and open Settings.
- Tune terminal font, size, scrollback, colors, log tail defaults, and the global Enhanced History setting.

## Read-only by design

Structured Operations use bounded, noninteractive SSH commands to read the Remote Host. They do not edit remote files, transfer files, install packages, manage services, manage containers, or run a monitoring loop. If you need to change the machine, use the interactive terminal with the permissions of the connected account.

Enabling Enhanced History is the explicit exception to the inspection-only rule. It changes the remote account's Bash startup configuration only when you ask it to, and the same screen can remove that integration.

## Support

| Where                        | Support                                                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local machine                | Windows 11 x64                                                                                                                                                  |
| SSH client                   | The Windows OpenSSH client already installed on the machine                                                                                                     |
| Structured remote inspection | Debian or Ubuntu family Linux with systemd, journald, and Bash                                                                                                  |
| Docker inspection            | Optional Docker installation on the remote host. The connected account must be able to query the Docker daemon, or you can retry a read-only request with sudo. |
| Other Linux hosts            | Terminal-only, best effort. The structured views target the environment above.                                                                                  |

## Install

The current published release is [v0.2.0](https://github.com/YounesCodes/control-room/releases/tag/v0.2.0). Download the latest Windows installer from [GitHub Releases](https://github.com/YounesCodes/control-room/releases/latest), run it, and start Control Room.

The installer is an unsigned, per-user NSIS package. Windows may show an unrecognized-publisher warning. The release includes a SHA-256 checksum beside the installer.

After launch:

1. Select **Add connection**.
2. Enter a display name, an SSH destination, and a username. Add a port or existing private-key path only when you need an override.
3. Select the Saved Connection to open a Workspace.
4. Select **Test structured access** in the connection dialog if you want to check the noninteractive authentication required by the inspection views.

## SSH expectations

Control Room uses the OpenSSH client already installed on Windows. It uses the normal Windows OpenSSH configuration and can detect a local `ssh-agent` with loaded identities. An identity-file override points to a key in its existing location. Control Room does not copy or import that key.

The interactive terminal uses normal OpenSSH behavior, including its prompts. Structured Operations use noninteractive OpenSSH mode, so they require public-key authentication or an agent identity that can connect without prompting for a password. If structured access fails, the interactive terminal may still work with a password.

## Security and local data

Control Room keeps its local state in SQLite. It stores:

- Saved Connection details, including the destination, username, optional port, and optional identity-file path.
- Application settings and disconnected Workspace layout.
- Cached host capability data such as the operating system and detected service or container counts.
- Enhanced History entries only when you enable capture. Each entry can include the command, working directory, timestamps, and exit code.

It deliberately does not persist:

- SSH passwords or sudo passwords.
- Imported or copied private keys.
- Terminal output.
- Fetched journald or Docker logs.

When a read-only request needs sudo, Control Room sends the password once for that retry and then discards it. The terminal itself is a normal SSH shell, so commands run there have the effects allowed by the remote account.

## Keyboard shortcuts

| Shortcut       | Action                                      |
| -------------- | ------------------------------------------- |
| `Ctrl+Shift+P` | Open the command palette                    |
| `Ctrl+Shift+T` | Switch the active Workspace to its Terminal |
| `Ctrl+Shift+R` | Reconnect the active Terminal Session       |
| `Ctrl+Shift+W` | Close the active Workspace                  |

## Development

Control Room uses a Tauri desktop shell, a React and TypeScript frontend, and a Rust backend. The backend owns native process management, SQLite, SSH argument construction, and remote command construction.

### Prerequisites

- Windows 11 x64
- Node.js 22 or newer
- Rust stable with the MSVC target
- Visual Studio C++ Build Tools and the Windows SDK
- WebView2 Runtime
- The Windows OpenSSH Client optional feature

Install the locked JavaScript dependencies and start the development app:

```bash
npm ci
npm run tauri dev
```

Run the local validation gate:

```bash
npm run check
```

This checks synchronized versions, formatting, ESLint, frontend tests and build, Rust formatting, Clippy, and Rust tests. Live SSH tests are ignored by default and require a host and account that you control.

Build the Windows installer locally with:

```bash
npm run tauri build
```

The build produces an unsigned per-user NSIS installer under `src-tauri/target/release/bundle/nsis/`.

## Releases

GitHub Actions validates pushes and pull requests on Windows. CI runs the frontend and Rust checks, audits the locked Rust dependencies, builds the NSIS installer, and publishes a SHA-256 checksum as an artifact.

Release tags use the `v*` pattern. The version in the tag must match `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`. A valid tag runs the release gate and publishes the unsigned installer and checksum to a GitHub release.
