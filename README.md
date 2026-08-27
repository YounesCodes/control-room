# Control Room

Control Room is a local Windows desktop application for opening interactive SSH sessions and inspecting Linux hosts. It uses your Windows OpenSSH setup instead of maintaining a second SSH stack.

The first release targets Windows 11 x64 and Debian or Ubuntu family hosts with systemd, journald, Bash, and optional Docker. Other Linux systems may still work as terminal-only destinations.

## Features

- Open several independent SSH sessions at the same time, including multiple sessions for one saved connection.
- Use an interactive terminal with Windows OpenSSH and ConPTY. It supports Unicode, ANSI and VT output, resizing, scrollback, copy and paste, control keys, Vim, Nano, top, htop, and tmux.
- Reconnect after a dropped session or clear the local terminal buffer without sending a command to the remote host.
- Inspect host details, systemd services, journald, and Docker through read-only operations with cached results and manual refresh.
- Search services and containers, then open their journal or Docker logs.
- Tail and follow journald or Docker logs with separate streams, pause and resume rendering, clear the view, and search loaded lines.
- Retry read-only inspections with sudo after a permission error. Passwords are never saved.
- Opt in to Bash Enhanced History to record commands, directories, timestamps, and exit codes from Control Room sessions. Pause, disable, clear, or remove it at any time.
- Save connections, settings, capabilities, History, and disconnected session layout in a local SQLite database.

Control Room does not store private keys, SSH passwords, sudo passwords, terminal output, or fetched logs. Structured features require noninteractive public-key or agent authentication; the interactive terminal can still show normal OpenSSH prompts.

## Development

Prerequisites:

- Windows 11 x64
- Node.js 22 or newer
- Rust stable with the MSVC target
- Visual Studio C++ Build Tools and Windows SDK
- WebView2 Runtime
- Windows OpenSSH client

Install locked dependencies and run the live-reloading desktop build:

```bash
npm ci
npm run tauri dev
```

Run the complete validation gate:

```bash
npm run check
```

See [testing](docs/TESTING.md) for the live SSH fixture and clean-machine acceptance checklist. Build the unsigned per-user installer with `npm run tauri build`; Windows may show an unrecognized-publisher warning.

## Releases

CI validates pushes and pull requests on Windows, audits locked Rust dependencies, and builds an NSIS artifact with a SHA-256 checksum. A tag matching the three synchronized project versions, such as `v0.1.0`, runs the same gate and publishes the unsigned installer and checksum to a GitHub release.

## Security and privacy

Enhanced History can contain secrets typed on command lines and is stored in the local application database only when enabled. See [SECURITY.md](SECURITY.md) for the complete boundary and private-reporting guidance.

## Documentation

- [Product specification](docs/PRODUCT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Testing](docs/TESTING.md)
- [Domain language](CONTEXT.md)
- [Architecture decisions](docs/adr/)

Control Room is licensed under the [MIT License](LICENSE). Contribution guidance is in [CONTRIBUTING.md](CONTRIBUTING.md).
