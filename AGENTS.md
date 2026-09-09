# Control Room agent rules

Control Room is a local Windows desktop tool for opening and inspecting Linux
systems through SSH, and for opening shells on the Windows machine it runs on.

This file owns product scope, trust boundaries, architecture and persistence
invariants, lifecycle rules, and the workflow an agent must follow. DESIGN.md
owns the visual system, layout, and UI conventions. Per-feature behavior belongs
to the code, its tests, and the user manual under `docs/`, not here.

## Scope

- Target Windows 11 x64, the installed Windows OpenSSH client, and ConPTY.
- Local Terminal covers four shell profiles: PowerShell 7, Windows PowerShell,
  Command Prompt, and Git Bash. Control Room is the terminal emulator, so never
  launch, embed, or parse Windows Terminal, and never open an external terminal
  window. Keep the profile model extensible enough for WSL or custom profiles
  without adding either now.
- Structured inspection targets Debian and Ubuntu family hosts with systemd,
  journald, Bash, and optional Docker. Other Linux systems are terminal-only,
  best effort.
- Do not add file transfer, remote file editing, service or container
  management, cloud accounts, collaboration, AI features, mobile support, host
  discovery, background monitoring, package updates, or private-key storage.
  "Package updates" means a Remote Host's packages; Control Room updating its own
  installer is a separate, in-scope thing. Keep the two verbally distinct
  wherever a user can see them, which is why Settings says "Control Room
  updates" rather than "Updates".
- Do not add local machine inspection either: no Windows services, process
  manager, local ports, local Docker, Event Log, WMI, or PowerShell
  administration. A local Workspace is terminal-only.

## Trust boundaries

1. Rust owns native process management, SQLite, SSH argument construction,
   remote command construction, and local shell discovery and construction.
   React never receives arbitrary shell execution, and may name a validated
   Local Shell Profile id and nothing else: the executable, its fixed arguments,
   and its working directory are resolved in Rust. No command takes a program,
   script, or argument list from the frontend, there is no `run_command`-style
   API, and the interactive terminal is the execution surface.
2. Never persist terminal output, fetched logs, SSH or sudo passwords, or
   imported private keys.
3. Keep remote operations read-only. Elevation never widens what a Structured
   Operation may do, only what it may read. Sudo is off by default; the user
   allows it for one host in the Saved Connection editor or for all of them in
   Settings. An allowed host elevates a read only when the account has
   passwordless sudo and runs it unelevated otherwise, so an allowance never
   becomes a password prompt on its own, and a read that ran unelevated is never
   reported as elevated. A one-shot sudo password stays available after a
   permission error whether or not elevation is allowed, and is never saved.
   Passwordless sudo is a host capability, reported separately from the
   allowance.
4. Rust emits approved typed records. React never receives raw `docker inspect`
   JSON, raw command output, or other unvalidated host text for it to parse.
5. Validate in Rust every identifier that reaches a command line: boot IDs, full
   container IDs, systemd unit names, UUIDs, and Local Shell Profile ids. An
   identifier that fails validation is an error, never a best-effort command.
6. Release notes and anything else fetched from a remote service are external
   text. Parse them into known shapes and render them as text nodes, never as
   markup.

## Architecture invariants

1. Keep system OpenSSH and ConPTY. Record a scope decision here before replacing
   either. SSH and local sessions share one pty lifecycle in `SessionManager`:
   one reader thread, one flow-control path, one write, resize, and kill
   implementation. Keep SSH-specific behavior (the connected marker, failure
   classification, Saved Connection state, host capability discovery, shell
   integration, Enhanced History) out of local sessions, and never let a local
   shell borrow a Saved Connection or reach the machine over SSH to localhost.
2. Give every Saved Connection, Workspace, Terminal Session, Structured
   Operation, and Log Stream an ID. A Workspace names exactly one target, a
   Saved Connection or a Local Shell Profile, as a typed distinction rather than
   a placeholder connection. Every remote-only field, view, and action stays
   remote-only rather than being faked for a local Workspace.
3. Structured Operations are bounded, read-only, and independent of Terminal
   Sessions. Never scan networks, test reachability, or repeat a read on a timer.
   Overview's live load meters are the one exception, and it is bounded rather
   than open: sample only while the pane is mounted, stop on unmount, stop while
   the window is hidden, never overlap round trips, and read nothing but `/proc`.
   Never store a sample, keep a history the user can read back, or alert on a
   value.
4. Report absence as absence. A missing reading is missing, never zero. A section
   Control Room did not read is never reported as unchanged, zero failures are
   never presented as a complete host health result, and missing or conflicting
   evidence stays unavailable or ambiguous. Compare captures deterministically by
   domain identity and draw no causal conclusion from what was collected.
5. Keep kernel socket facts (protocol, address family, bind address, port)
   separate from correlated ownership, and correlate ownership only from
   unambiguous evidence: one visible PID with a validated systemd unit, or an
   exact published address, port, and protocol for a container. The single
   exception is systemd's own claim on a socket it activates, dropped only for
   pid 1 and only while another holder remains. Report binding exposure and
   firewall policy separately, and never claim a bind means Internet
   reachability.
6. Collect only the fields a feature needs. Never collect environment values,
   command arguments, arbitrary labels, health logs, host mount sources, or full
   process arguments, and never infer owners from process names. Inspect a
   container only by its full stable ID, keep systemd inspection to system-scope
   units, and group containers only by validated Compose labels, keeping each
   instance distinct with an Ungrouped fallback.
7. The in-app updater is optional infrastructure, never a boot dependency. Rust
   owns the endpoint, the signature check, and the installer; React names an
   intent and never receives a URL, installer bytes, or a way to skip
   verification. One application-level lifecycle owns it: one timer, one
   in-flight check, no per-Workspace or per-pane checking. Downloading never
   installs, installing is always confirmed because it ends live sessions, and a
   signature that does not verify is a hard failure with no "install anyway".

## Persistence rules

1. SQLite holds Saved Connections and their local organization metadata,
   settings, host capabilities, Enhanced History, Scratchpad notes, Host
   Baselines, and disconnected Workspace layout. Nothing else is durable.
2. Every other Structured Operation result lives in Workspace memory only: host
   facts, units, sockets, firewall and connection snapshots, container
   inspections, boot evidence, and each independent Log Stream. A baseline
   comparison against live machine state is a user-initiated read rather than a
   capture, and is never saved.
3. Keep Connection Groups, tags, ordering, and collapse state local. A Saved
   Connection belongs to at most one group, Ungrouped is derived, and deleting a
   group returns its connections to Ungrouped without contacting a Remote Host.
   Tags are filtering metadata: they grant no permissions and trigger nothing.
4. Keep Scratchpad notes plain-text, local, user-authored, and size-bounded. Each
   Saved Connection has one note, one global note is shared across the app,
   closing a Workspace deletes neither, and neither ever captures terminal or log
   output automatically.
5. A Host Baseline stores normalized facts, per-section collection time and
   support status, user label, schema version, and host identity evidence, never
   raw command output, logs, credentials, or environment values. Version each
   section's fact shape on its own so one section's change never blocks
   comparison of the others.
6. The only stored updater data is the small one-time notice naming the version
   just installed, cleared once shown. Never persist installer bytes.

## Lifecycle rules

1. Keep several simultaneous Workspaces, including more than one for a single
   Saved Connection.
2. Restore saved Workspace layout as disconnected after restart. Never
   auto-reconnect, and never auto-start a local shell. Restored local tabs come
   back present and stopped. Workspace state written before Local Terminal
   existed must keep restoring, and a local tab whose shell is no longer
   installed is dropped the way one for a deleted Saved Connection is.
3. Enhanced History is opt-in, Bash-only, reversible, and limited to commands the
   installed shell integration reports. Never infer commands from keystrokes or
   import the host's shell history. It is remote-only: local shells record no
   history at all.
4. Capture a Host Baseline only when the user asks. Never schedule, poll, or
   recapture in the background. Stopping a capture keeps the sections that
   finished and records the rest as skipped, and the five section states
   (collected, partial, unsupported, unavailable, skipped) stay distinct
   everywhere, so missing evidence never reads as an unchanged host.
5. Offer a local shell only when it is installed, resolved deterministically from
   standard Windows locations plus `PATH` for PowerShell 7 and Git for Windows,
   and start it with the user's own environment in the user profile directory.
   Git Bash means `bash.exe` from Git for Windows, never `git-bash.exe` or
   another terminal frontend, and `bash.exe` is never taken from `PATH` directly,
   because `System32\bash.exe` is the WSL launcher. Set `TERM` only for a shell
   that reads it. Reject unknown profile ids, and report a shell that disappeared
   after discovery as unavailable rather than failing obscurely.
6. Keep the terminal's own gestures built in rather than optional. A mouse right
   click copies a selection, pastes when there is none, and belongs to the
   program in the pty while that program is reading the mouse. A pointer right
   click inside the terminal never opens the webview menu, and that suppression
   is decided separately from who owns the clipboard.
7. "New terminal" chooses a target, any Saved Connection or installed local
   shell, and opens an independent Workspace for it. Choosing the active target
   opens a second terminal rather than reusing or mutating the Workspace the menu
   was opened from.
8. Automatic update checks are a Settings preference, default on: a startup
   delay, then a periodic recheck while the app stays open, plus a refresh when
   it returns to the foreground with a stale result. A failed automatic check is
   silent. A manual check stays available when the preference is off and may
   report why it failed.
9. In split list/detail views, a filter must never leave a hidden item looking
   current. Keep the selection visible, or replace its details with an explicit
   filtered-selection state and a one-step way to reveal it. Empty lists and
   their detail panes must describe the same state.
10. Keep primary navigation and dialog actions reachable at the supported
    minimum window height. Dialog headers and action rows stay visible while
    their body scrolls.

## Agent workflow

- Add tests for parsers, argument builders, lifecycle changes, and regressions.
- Keep README, DESIGN.md, `docs/`, and this file current when behavior changes.
  Do not redesign unrelated UI.
- Do not commit or push unless the user asks.

## Validation

Run `npm ci` and `npm run check` before handoff. Build the installer with
`npm run tauri build`. Live SSH tests are ignored by default and need a host and
account you control.

Neither command needs the updater signing key: updater artifacts are produced
only by the release workflow, through `src-tauri/tauri.release.conf.json`. The
release does need `TAURI_SIGNING_PRIVATE_KEY` and the public key committed in
`src-tauri/tauri.conf.json`, and it fails rather than publishing a release the
updater cannot verify.

## Project language

- **Saved Connection**: a reusable SSH destination and username, with optional
  port or identity-file overrides. Several can point at one **Remote Host**, the
  Linux system reached through a connection.
- **Workspace**: an open view of one target that groups a Terminal Session with
  whatever else that target supports. A remote Workspace is a Saved Connection
  plus the inspection views; a local Workspace is a Local Shell Profile and its
  terminal, and nothing else. One target can have several Workspaces.
- **Local Shell Profile**: one of the four Windows shells Control Room can host,
  identified by a stable id (`powershell-7`, `windows-powershell`,
  `command-prompt`, `git-bash`). The id is the only part the frontend may send
  back.
- **Terminal Session**: one interactive shell inside a Workspace, remote or
  local. Its state belongs to the session, not to the connection: a remote
  session connects and disconnects, a local one runs and stops.
- **Structured Operation**: a bounded, read-only inspection request that runs
  independently of Terminal Sessions.
- **Enhanced History**: a local record of commands the installed Bash integration
  reports, not an import of the host's own shell history.
- **Host Baseline**: an explicit, timestamped capture of normalized host state
  for one Saved Connection, split into independently versioned sections.
- **Application Update**: a newer Control Room published to GitHub Releases,
  signed and verified before it replaces the app on this Windows machine.
