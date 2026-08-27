# Control Room agent rules

## Scope

Control Room is a local Windows desktop tool for opening and inspecting Linux systems through SSH.

- Target Windows 11 x64, the installed Windows OpenSSH client, and ConPTY.
- Structured inspection targets Debian and Ubuntu family hosts with systemd, journald, Bash, and optional Docker.
- Other Linux systems are terminal-only, best effort.
- Do not add file transfer, remote file editing, service or container management, cloud accounts, collaboration, AI features, mobile support, automatic discovery, monitoring, package updates, or private-key storage.

## Architecture and data rules

1. Rust owns native process management, SQLite, SSH argument construction, and remote command construction.
2. React must never receive arbitrary shell execution.
3. Keep system OpenSSH and ConPTY. Record an explicit scope decision in this file before replacing either one.
4. Use IDs for every Saved Connection, Workspace, Terminal Session, Structured Operation, and Log Stream.
5. Never persist terminal output, fetched logs, SSH passwords, sudo passwords, or imported private keys.
6. Keep remote operations read-only. A sudo retry is allowed only after permission denial and must not save the password.

## Required behavior

1. Preserve multiple simultaneous Workspaces, including several for one Saved Connection.
2. Restore saved Workspace layout as disconnected after restart. Never reconnect automatically.
3. Enhanced History is opt-in, Bash-only, reversible, and limited to commands reported by the installed shell integration. Never infer commands from keystrokes or import remote shell history.
4. Keep service and container inspection read-only. Keep each Log Stream independent and in memory.
5. Add tests for parsers, argument builders, lifecycle changes, and regressions.
6. Keep the README and this file current when behavior changes. Do not redesign unrelated UI.
7. Do not commit or push unless the user asks.

## Validation

Run `npm ci` and `npm run check` before handoff. Build the Windows installer with `npm run tauri build`. Live SSH tests are ignored by default and require a host and account the user controls.

## Project language

**Saved Connection**: Reusable SSH destination and username, with optional port or existing identity-file overrides.

**Remote Host**: The Linux system reached through a Saved Connection. Multiple Saved Connections may refer to one Remote Host.

**Workspace**: An open view of one Saved Connection that groups a Terminal Session with inspection features. A Saved Connection may have multiple Workspaces.

**Terminal Session**: One interactive SSH shell inside a Workspace. Its state belongs to the session, not the Saved Connection or Remote Host.

**Structured Operation**: A bounded, read-only inspection request that runs independently of Terminal Sessions.

**Log Stream**: A live journald or Docker log reader with its own lifecycle.

**Enhanced History**: A local record of commands reported by Control Room's installed Bash integration. It does not import a Remote Host's existing shell history.
