# Control Room agent rules

Control Room is a local Windows desktop tool for opening and inspecting Linux
systems through SSH. The visual system, tokens, and UI conventions live in
DESIGN.md.

## Scope

- Target Windows 11 x64, the installed Windows OpenSSH client, and ConPTY.
- Structured inspection targets Debian and Ubuntu family hosts with systemd,
  journald, Bash, and optional Docker. Other Linux systems are terminal-only,
  best effort.
- Do not add file transfer, remote file editing, service or container
  management, cloud accounts, collaboration, AI features, mobile support, host
  discovery, background monitoring, package updates, or private-key storage.

## Architecture and data rules

1. Rust owns native process management, SQLite, SSH argument construction, and
   remote command construction. React never receives arbitrary shell execution.
2. Keep system OpenSSH and ConPTY. Record a scope decision here before replacing
   either.
3. Give every Saved Connection, Workspace, Terminal Session, Structured
   Operation, and Log Stream an ID.
4. Never persist terminal output, fetched logs, SSH or sudo passwords, or
   imported private keys.
5. Keep remote operations read-only. A sudo retry is allowed only after a
   permission error and must not save the password.

## Required behavior

1. Keep several simultaneous Workspaces, including more than one for a single
   Saved Connection.
2. Restore saved Workspace layout as disconnected after restart. Never
   auto-reconnect.
3. Enhanced History is opt-in, Bash-only, reversible, and limited to commands the
   installed shell integration reports. Never infer commands from keystrokes or
   import the host's shell history.
4. Keep systemd unit and container inspection read-only. The Systemd view covers
   system-scope services, timers, mounts, and sockets, sorts failures first, and
   never treats zero failures as a complete health result. Keep each Log Stream
   independent and in memory.
5. Derive Docker Compose grouping only from validated project and service labels.
   Keep every container instance distinct and retain an Ungrouped fallback.
6. Keep port inspection to bounded TCP and UDP listener snapshots. Never scan,
   test reachability, collect full process arguments, or infer owners from names.
   Service navigation requires one unambiguous PID with a validated systemd unit;
   container navigation requires an exact published address, port, and protocol.
   The Ports firewall and established-connection snapshots stay bounded and
   read-only, live only in Workspace memory, and are never persisted. Report
   binding exposure and firewall policy separately, and never claim a bind means
   Internet reachability.
7. Inspect one Docker container only by its full stable ID. Collect typed state,
   health, lifecycle, restart, port, network, mount, image, and validated Compose
   facts. Never collect environment values, command arguments, arbitrary labels,
   health logs, or host mount sources.
8. Add tests for parsers, argument builders, lifecycle changes, and regressions.
9. Keep README, DESIGN.md, and this file current when behavior changes. Do not
   redesign unrelated UI.
10. Do not commit or push unless the user asks.

## Validation

Run `npm ci` and `npm run check` before handoff. Build the installer with
`npm run tauri build`. Live SSH tests are ignored by default and need a host and
account you control.

## Project language

- **Saved Connection**: a reusable SSH destination and username, with optional
  port or identity-file overrides.
- **Remote Host**: the Linux system reached through a connection. Several
  connections can point at one host.
- **Workspace**: an open view of one connection that groups a Terminal Session
  with the inspection views. A connection can have several Workspaces.
- **Terminal Session**: one interactive SSH shell inside a Workspace. Its state
  belongs to the session, not the connection.
- **Structured Operation**: a bounded, read-only inspection request that runs
  independently of Terminal Sessions.
- **Systemd Unit**: a canonical system-scope service, timer, mount, or socket
  returned by the bounded Systemd inspection.
- **Listening Socket**: one TCP or UDP listener returned by a manual, bounded
  host snapshot. Kernel socket facts remain separate from correlated ownership.
- **Container Inspection**: a timestamped, in-memory detail record collected by
  full Docker ID without lifecycle controls or raw inspect JSON in React.
- **Log Stream**: a live journald or Docker log reader with its own lifecycle,
  held in memory.
- **Enhanced History**: a local record of commands the installed Bash integration
  reports. It does not import the host's existing shell history.
