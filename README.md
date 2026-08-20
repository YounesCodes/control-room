# Control Room

Control Room is a local Windows desktop application for opening interactive SSH sessions and inspecting Linux hosts. It uses the Windows OpenSSH client, ConPTY, React, Rust, xterm.js, and SQLite.

The first release targets Windows 11 x64 and Debian or Ubuntu family hosts with systemd, journald, Bash, and optional Docker. Other Linux systems may still work as terminal-only destinations.

## Development

Prerequisites:

- Windows 11 x64
- Node.js 22 or newer
- Rust stable with the MSVC target
- Visual Studio C++ Build Tools and Windows SDK
- WebView2 Runtime
- Windows OpenSSH client

Install and run:

```bash
npm install
npm run tauri dev
```

Validation:

```bash
npm run lint
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run tauri build
```

The ignored fixture tests exercise Windows `ssh.exe` inside ConPTY, structured Debian discovery, and reversible Enhanced History metadata using an isolated temporary remote home. Run them only against an SSH host you control:

```powershell
$env:CONTROL_ROOM_TEST_HOST = "192.0.2.10"
$env:CONTROL_ROOM_TEST_USER = "your-user"
$env:CONTROL_ROOM_TEST_PORT = "22"
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
```

The NSIS installer is written under `src-tauri/target/release/bundle/nsis/`.

## Documentation

- [Product specification](docs/PRODUCT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Domain language](CONTEXT.md)
- [Architecture decisions](docs/adr/)
