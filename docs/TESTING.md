# Testing

## Automated gate

Run the complete local gate from the repository root:

```bash
npm ci
npm run check
```

`npm run check` verifies version parity, formatting, ESLint, frontend tests, the production web build, Rust formatting, Clippy, and Rust tests. The test suite includes database migrations, stale cache recovery, literal History search, remote-output parsers, process-state classification, terminal backpressure, bounded 15 MiB log input, connection validation, OSC validation, and shared accessibility markup.

Build the per-user NSIS installer separately:

```bash
npm run tauri build
```

The installer is written under `src-tauri/target/release/bundle/nsis/`.

## Live SSH fixture

The ignored tests use real Windows `ssh.exe`, ConPTY, systemd, journald, Docker, and an isolated temporary remote home for Enhanced History. Run them only against a host and account you control.

From Git Bash:

```bash
CONTROL_ROOM_TEST_HOST=192.0.2.10 \
CONTROL_ROOM_TEST_USER=your-user \
CONTROL_ROOM_TEST_PORT=22 \
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
```

The fixture requires noninteractive public-key authentication for structured operations. The History test creates and deletes only its own temporary directory under `/tmp` on the fixture.

## Manual release acceptance

On a clean Windows 11 x64 user profile:

1. Install the unsigned NSIS package without elevation.
2. Add three Saved Connections, including two Workspaces for one connection.
3. Exercise interactive prompts, resize, Unicode, control keys, Vim or Nano, top or htop, tmux, copy, paste, disconnect, reconnect, clear, and preserved scrollback.
4. Verify Overview, Services, journald, Docker, and Docker logs independently.
5. Verify permission denial and explicit sudo retry without saved credentials.
6. Install Enhanced History, capture exact commands and exit codes, restart the app, search literal `%` and `_`, pause, disable capture, remove the integration, and verify unrelated `.bashrc` content remains.
7. Verify authentication, host-key, refused, timeout, unsupported, empty, and connection-loss states.
8. Uninstall the app and confirm the expected per-user uninstall behavior.
