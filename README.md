# Control Room

Control Room is a local Windows desktop application for opening interactive SSH sessions and inspecting Linux hosts. It uses your Windows OpenSSH setup instead of maintaining a second SSH stack.

The first release targets Windows 11 x64 and Debian or Ubuntu family hosts with systemd, journald, Bash, and optional Docker. Other Linux systems may still work as terminal-only destinations.

## Features

- Multiple simultaneous SSH Workspaces, with a visible New terminal action and Ctrl+Shift+N for additional sessions on the same Saved Connection
- Interactive ConPTY and xterm.js terminal with resize, Unicode, copy and paste, scrollback that survives Settings navigation, and reconnect into a clean terminal buffer
- Black-and-white Docker Desktop-inspired navigation with detected Debian and Ubuntu marks, semantic terminal states, global connection search, a bounded Saved Connection list, contextual Workspace navigation, and in-window terminal tabs
- A centered 1180×700 frameless window with integrated controls that remains resizable down to the supported 960×640 minimum
- Cached host, systemd, journald, and Docker inspection with explicit refresh
- Independent, bounded journald and Docker log streams
- Explicit one-shot sudo retry for read-only structured requests
- Optional Bash Enhanced History with exact commands, directories, timestamps, and exit codes
- Local SQLite persistence for connections, settings, capabilities, and opted-in History

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

CI validates pushes and pull requests on Windows and builds an NSIS artifact. A tag matching the three synchronized project versions, such as `v0.1.0`, runs the same gate and publishes the unsigned installer to a GitHub release.

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
