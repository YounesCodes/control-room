# Control Room architecture

## Boundaries

React renders state and calls narrow Tauri commands. Rust owns process lifecycle, SSH arguments, remote commands, SQLite, and filesystem changes. The frontend cannot submit arbitrary remote shell commands outside the interactive terminal byte stream.

## Terminal path

```text
xterm.js ⇄ ordered Tauri channel/commands ⇄ SessionManager ⇄ PtyBackend ⇄ ConPTY ⇄ ssh.exe
```

Terminal output crosses IPC as ordered byte chunks and enters xterm.js as `Uint8Array`. Small lifecycle events use Tauri events. Each Terminal Session owns its PTY, child process, writer, output channel, state, and explicit identifier.

The frontend acknowledges bytes after xterm.js parses them. Rust stops reading after 512 KiB is unacknowledged and resumes when acknowledgements arrive. Input typed while SSH starts is capped at 64 KiB. Reconnecting replaces the SSH process without replacing the xterm.js instance, so scrollback remains visible.

Terminal startup sends only a Saved Connection ID to Rust. Rust loads the current SQLite record before constructing OpenSSH arguments. Editing a Saved Connection does not replace a running SSH process, but new terminals and reconnects use the saved changes.

The remote login command emits a fixed private OSC marker after OpenSSH authentication and before starting the supported Bash login shell. Rust reports the Terminal Session as connected only after it reads that marker. xterm.js consumes the marker without drawing it. Password and host-key prompts remain in the connecting state.

The terminal Clear action writes ECMA-48 erase-display, erase-scrollback, and cursor-home sequences into xterm.js locally. It does not send a shell command, reset terminal modes, or modify the Remote Host. Terminal color settings map the configurable foreground and six ANSI categories into xterm.js; Remote Host applications still choose which ANSI category each token uses.

Terminal padding belongs on the xterm.js element rather than its parent container. FitAddon subtracts padding from that measured element when calculating rows, which keeps the ConPTY height and the rendered canvas aligned and prevents full-screen applications from losing their last row.

Opening another terminal creates another Workspace and an independent ConPTY and `ssh.exe` process for the same Saved Connection. Control Room does not infer a client-side maximum. OpenSSH and the Remote Host enforce their configured connection limits, and a rejected session remains isolated in its own error state.

Focused terminal splits use a frontend-only binary tree. Each split replaces the focused leaf with a vertical or horizontal pair, matching Windows Terminal pane behavior. The tree calculates bounded percentage rectangles for the existing Workspace components, so nesting panes never moves a terminal off-screen or remounts its xterm.js instance. Choosing a Saved Connection in the split menu creates one new Workspace and Terminal Session; choosing an existing terminal reuses its current Workspace and SSH process.

## Structured path

```text
React operation request ⇄ typed Tauri command ⇄ RemoteCommandExecutor ⇄ ssh.exe ⇄ Linux tool
```

The backend selects a fixed command specification and validates identifiers before constructing remote arguments. Overview, systemd, Docker, journald, and Docker logs share this executor. On Windows, these non-interactive processes use `CREATE_NO_WINDOW`, so they never open a separate console. Interactive terminal authentication is independent; structured requests require noninteractive OpenSSH authentication.

The connection dialog can test unsaved details. Rust validates the same input contract used for saving and runs the fixed capability inspection without writing the temporary details to SQLite.

At most two structured SSH operations run concurrently per Saved Connection. A queued request fails after four seconds, so queueing plus the 20-second SSH deadline stays below the frontend's 25-second timeout. Workspaces cache service and container lists for 30 seconds and pass exact log selections between panes, avoiding repeated SSH handshakes during normal navigation.

The frontend gives capability, service, and container discovery 25 seconds to return across IPC. If an IPC reply is lost or stalls beyond the backend's 20-second command deadline, the active pane leaves its loading state and presents a retryable error instead of waiting indefinitely. Log-source discovery uses the same bounded service and container requests.

## Persistence

Rust stores Saved Connections, cached capabilities, History settings, application settings, disconnected Workspace metadata, and Enhanced History in SQLite under the Tauri application-data directory. Rust also supplies the frontend with the default settings and supported log-tail sizes, keeping reset behavior and backend validation on one contract. Persisted Workspace metadata contains IDs, local labels, selected pages, History pause state, and the terminal split tree. On startup, React joins that metadata to current Saved Connections and drops entries whose connection was deleted. Restored Workspaces do not contain session IDs and do not start SSH until the user reconnects.

Terminal output, fetched logs, SSH passwords, sudo passwords, live process state, service and container caches, and log selections are never persisted.

SQLite uses numbered `user_version` migrations. Cached capability and settings JSON tolerate missing fields from older versions; corrupt cache records are discarded and refreshed instead of preventing startup.

## Enhanced History

An explicitly installed Bash script emits private OSC metadata for command boundaries, exact history text, working directory, timestamps, and exit status. xterm.js consumes that metadata without rendering it and sends typed History records to Rust. The integration does not import `.bash_history` and can be removed without disturbing unrelated shell configuration.

Remote script installation and per-Saved-Connection capture are separate controls. Global disable prevents new integrated Bash sessions, while Workspace pause suppresses records in the frontend. Bash startup edits use marker validation and same-directory atomic replacements.

## Streams and flow control

Terminal and log streams have independent identifiers and cancellation. Terminal output uses ordered channels rather than general JSON events. The frontend acknowledges terminal bytes after xterm.js has parsed them; the backend uses bounded buffering so the WebView cannot grow without limit during high output.

Log rendering keeps at most 10,000 lines and 5 MiB per active or paused buffer. React updates every 80 ms for small views, 250 ms after 1 MiB, and 500 ms after 4 MiB. Search waits 180 ms after typing. Control Room never persists the result.
