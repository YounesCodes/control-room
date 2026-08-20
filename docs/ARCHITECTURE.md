# Control Room architecture

## Boundaries

React renders state and calls narrow Tauri commands. Rust owns process lifecycle, SSH arguments, remote commands, SQLite, and filesystem changes. The frontend cannot submit arbitrary remote shell commands outside the interactive terminal byte stream.

## Terminal path

```text
xterm.js ⇄ ordered Tauri channel/commands ⇄ SessionManager ⇄ PtyBackend ⇄ ConPTY ⇄ ssh.exe
```

Terminal output crosses IPC as ordered byte chunks and enters xterm.js as `Uint8Array`. Small lifecycle events use Tauri events. Each Terminal Session owns its PTY, child process, writer, output channel, state, and explicit identifier.

## Structured path

```text
React operation request ⇄ typed Tauri command ⇄ RemoteCommandExecutor ⇄ ssh.exe ⇄ Linux tool
```

The backend selects a fixed command specification and validates identifiers before constructing remote arguments. Overview, systemd, Docker, journald, and Docker logs share this executor. Interactive terminal authentication is independent; structured requests require noninteractive OpenSSH authentication.

## Persistence

Rust stores Saved Connections, cached capabilities, History settings, application settings, and Enhanced History in SQLite under the Tauri application-data directory. Terminal output, fetched logs, SSH passwords, and sudo passwords are never persisted.

## Enhanced History

An explicitly installed Bash script emits private OSC metadata for command boundaries, exact history text, working directory, timestamps, and exit status. xterm.js consumes that metadata without rendering it and sends typed History records to Rust. The integration does not import `.bash_history` and can be removed without disturbing unrelated shell configuration.

## Streams and flow control

Terminal and log streams have independent identifiers and cancellation. Terminal output uses ordered channels rather than general JSON events. The frontend acknowledges terminal bytes after xterm.js has parsed them; the backend uses bounded buffering so the WebView cannot grow without limit during high output.
