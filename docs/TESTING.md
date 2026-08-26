# Testing

## Automated gate

Run the complete local gate from the repository root:

```bash
npm ci
npm run check
```

`npm run check` verifies version parity, formatting, ESLint, frontend tests, the production web build, Rust formatting, Clippy, and Rust tests. The test suite includes database migrations, stale cache and invalid-settings recovery, literal History search, remote-output parsers, child-process cleanup, process-state classification, terminal backpressure, bounded 15 MiB log input, Workspace pane lifecycle isolation, connection validation, OSC validation, shared accessibility markup, and a palette regression check that limits UI color to semantic green, amber, and red.

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
2. Verify the frameless window opens centered and fully on-screen at 1280×800, with a black-and-white palette and color limited to semantic status, warning, failure, destructive actions, and terminal ANSI output. Connections starts at the top of the full-height sidebar with no separate product wordmark. With a Workspace open, its feature navigation begins directly below the bounded connection list, the Workspace tab strip starts flush with the content edge, the Overview page uses a functional title, and the Saved Connection name appears only in the connection list and Workspace tab. Cached Debian or Ubuntu hosts show the matching monochrome OS mark in both locations, an undetected or unsupported host shows a generic server mark, and the connection-state dot remains inside the Terminal view. Drag the window from the application header or Connections heading, exercise minimize, maximize or restore, and close, then resize it down to the supported 960×640 minimum and back up.
3. Add three Saved Connections. For a new uncached Debian or Ubuntu connection, connect in Terminal and verify its generic server mark changes to the matching OS mark in both the sidebar and tab without first visiting Overview. Use New terminal and Ctrl+Shift+N to open at least two connected Workspaces for one Saved Connection, then verify a failure in one does not close the other.
4. Exercise interactive prompts, resize, Unicode, control keys, Vim or Nano, top or htop, tmux, copy, paste, disconnect, reconnect, clear, and preserved scrollback. On both Debian and Ubuntu, produce more than one screen of output, click Clear, and verify the viewport and scrollback are empty with the cursor at the top-left before new remote output arrives. Enter terminal focus mode from the tab strip and with F11. Verify the open Workspace tabs, terminal, and minimize, maximize or restore, and close controls remain visible. Split the focused pane vertically and horizontally. Add both an existing terminal and a new Terminal Session chosen from Saved Connections. Confirm each later split divides only the focused pane, every pane stays inside the terminal area after five or more panes, and every pane shows its Workspace label. Switch active panes, remove a pane without closing its Workspace, and verify F11 restores the full application shell without losing the split. Verify reconnect clears the previous Terminal Session output before the replacement session starts. Open Settings, change the terminal text, green, and blue colors, and verify an open Terminal Session updates without reconnecting. Reset colors, verify a small gap remains below Save settings at the end of the scroll area, and return to Terminal, then verify the terminal output and session remain intact.
5. Verify Overview, Services, journald, Docker, and Docker logs independently.
6. Verify permission denial and explicit sudo retry without saved credentials.
7. Install Enhanced History, capture exact commands and exit codes, restart the app, search literal `%` and `_`, pause, disable capture, remove the integration, and verify unrelated `.bashrc` content remains.
8. Verify authentication, host-key, refused, timeout, unsupported, empty, and connection-loss states.
9. Uninstall the app and confirm the expected per-user uninstall behavior.
