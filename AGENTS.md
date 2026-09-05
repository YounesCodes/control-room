# Control Room agent rules

Control Room is a local Windows desktop tool for opening and inspecting Linux
systems through SSH, and for opening shells on the Windows machine it runs on.
The visual system, tokens, and UI conventions live in DESIGN.md.

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
  "Package updates" means a Remote Host's packages. Control Room updating its own
  installer on the Windows machine it runs on is a separate thing and is in
  scope; keep the two verbally distinct wherever a user can see them, which is
  why Settings says "Control Room updates" rather than "Updates".
- Do not add local machine inspection: no Windows services, process manager,
  local ports, local Docker inspection, Event Log, WMI, or PowerShell
  administration. A local Workspace is terminal-only.

## Architecture and data rules

1. Rust owns native process management, SQLite, SSH argument construction,
   remote command construction, and local shell discovery and construction.
   React never receives arbitrary shell execution. React may name a validated
   Local Shell Profile id and nothing else: the executable, its fixed arguments,
   and its working directory are resolved in Rust, and no command takes a
   program, script, or argument list from the frontend. There is no
   `run_command`-style API, and the interactive terminal is the execution
   surface.
2. Keep system OpenSSH and ConPTY. Record a scope decision here before replacing
   either. SSH and local sessions share one pty lifecycle in `SessionManager`:
   one reader thread, one flow-control path, one write, resize, and kill
   implementation. Keep SSH-specific behavior (the connected marker, failure
   classification, Saved Connection state, host capability discovery, shell
   integration, Enhanced History) out of local sessions, and never let a local
   shell borrow a Saved Connection or reach the machine over SSH to localhost.
3. Give every Saved Connection, Workspace, Terminal Session, Structured
   Operation, and Log Stream an ID. A Workspace names exactly one target, a
   Saved Connection or a Local Shell Profile, as a typed distinction rather than
   a placeholder connection.
4. Never persist terminal output, fetched logs, SSH or sudo passwords, or
   imported private keys.
5. Keep remote operations read-only. Elevation never widens what a Structured
   Operation may do, only what it may read. Sudo is off by default and is turned
   on by the user, either for one host in the Saved Connection editor or for all
   of them in Settings. An allowed host runs a read under sudo only when the
   account has passwordless sudo, and runs it unelevated otherwise, so an
   allowance never becomes a password prompt on its own. A one-shot sudo
   password stays available after a permission error whether or not elevation is
   allowed, and is never saved. Report whether an account has passwordless sudo
   as a host capability, separately from whether the user allowed elevation. A
   permission the account cannot act on must not be shown as if reads were
   elevated.

## Required behavior

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
4. Keep systemd unit and container inspection read-only. The Systemd view covers
   system-scope services, timers, mounts, and sockets, sorts failures first, and
   never treats zero failures as a complete health result. Keep each Log Stream
   independent and in memory.
5. Keep Connection Groups, tags, ordering, and collapse state local.
   A Saved Connection belongs to at most one group. Deleting a group returns its
   connections to the derived Ungrouped section and never contacts a Remote Host.
6. Derive Docker Compose grouping only from validated project and service labels.
   Keep every container instance distinct and retain an Ungrouped fallback.
7. Keep port inspection to bounded TCP and UDP listener snapshots. Never scan,
   test reachability, collect full process arguments, or infer owners from names.
   Service navigation requires one unambiguous PID with a validated systemd unit;
   container navigation requires an exact published address, port, and protocol.
   systemd's own claim on a socket it activates is the one holder that may be
   dropped, because pid 1 holding a listening descriptor says how a service was
   started rather than who is serving. Drop it only when another holder remains,
   and only for pid 1 itself. Two services that genuinely disagree stay ambiguous.
   The Ports firewall and established-connection snapshots stay bounded and
   read-only, live only in Workspace memory, and are never persisted. Report
   binding exposure and firewall policy separately, and never claim a bind means
   Internet reachability.
8. Inspect one Docker container only by its full stable ID. Collect typed state,
   health, lifecycle, restart, port, network, mount, image, and validated Compose
   facts. Never collect environment values, command arguments, arbitrary labels,
   health logs, or host mount sources.
9. Keep Boot Diagnostics bounded and observational. Validate boot IDs, identify
   current versus previous boots, timestamp partial sections, cap boot, unit, and
   journal rows, and never persist boot evidence or claim a slow unit caused a
   problem.
10. Overview's live load meters are the one read that repeats on a timer, and
    the exception is bounded rather than open. Sample only while the Overview
    pane is mounted, stop on unmount, stop while the window is hidden, never
    overlap round trips, and read nothing but `/proc`. Never persist a sample,
    never keep a history the user can read back, and never alert on a value.
    This is not background monitoring: there is no agent, no schedule that
    outlives the pane, and nothing stored. A missing reading is reported as
    missing, because a zero would read as an idle host.
11. Keep Scratchpad notes plain-text, local, user-authored, and size-bounded.
    Each Saved Connection has one note, and one global note is shared across all
    connections and Workspaces. Closing a Workspace deletes neither. Never capture
    terminal or log output automatically.
12. Capture a Host Baseline only when the user asks. Never schedule, poll, or
    recapture in the background. Store normalized facts, per-section collection
    time, support status, user label, schema version, and host identity evidence.
    Never store raw command output, logs, credentials, or environment values.
    Keep collected, partial, unsupported, unavailable, and skipped distinct, and
    never report a section Control Room did not read as unchanged. Stopping a
    capture keeps the sections that finished and records the rest as skipped.
    Version each section's fact shape on its own so one section's change never
    blocks comparison of the others. Compare baselines
    deterministically by domain identity and draw no causal conclusion. A
    comparison against live machine state is still an explicit, user-initiated
    read: never save it as a capture and never repeat it on its own.
13. Keep the terminal's own gestures built in rather than optional. A mouse
    right click copies a selection, pastes when there is none, and belongs to
    the program in the pty while that program is reading the mouse. A pointer
    right click inside the terminal never opens the webview menu, and that
    suppression is decided separately from who owns the clipboard, because
    deriving one from the other is what let the menu through. "New terminal"
    chooses a target rather than repeating the active one, and never mutates
    the Workspace it was opened from.
14. Local shells are offered only when installed, resolved deterministically
    from standard Windows locations plus `PATH` for PowerShell 7 and Git for
    Windows, and started with the user's own environment in the user profile
    directory. Git Bash means `bash.exe`, never `git-bash.exe` or another
    terminal frontend, and `bash.exe` is never taken from `PATH` directly,
    because `System32\bash.exe` is the WSL launcher. Set `TERM` only for a shell
    that reads it, and never invent Windows Terminal variables. Reject unknown
    profile ids, and report a shell that disappeared after discovery as
    unavailable rather than failing obscurely.
15. Keep the in-app updater optional infrastructure, never a boot dependency.
    Rust owns the endpoint, the signature check, and the installer; React names
    an intent and never receives a URL, installer bytes, or a way to skip
    verification. There is one application-level update lifecycle: one timer,
    one in-flight check, no per-Workspace or per-pane checking. Automatic checks
    are a Settings preference, default on, roughly ten seconds after start and
    twelve hours apart, and a failed automatic check is silent. A manual check
    stays available when the preference is off and may report why it failed.
    Downloading never installs, installing is always confirmed because it ends
    live sessions, and a signature that does not verify is a hard failure with
    no "install anyway". Never persist installer bytes: the only stored updater
    data is the small one-time notice naming the version just installed, cleared
    once shown. Release notes are external text and are rendered as text.
16. Add tests for parsers, argument builders, lifecycle changes, and regressions.
17. Keep README, DESIGN.md, and this file current when behavior changes. Do not
    redesign unrelated UI.
18. Do not commit or push unless the user asks.

## Validation

Run `npm ci` and `npm run check` before handoff. Build the installer with
`npm run tauri build`. Live SSH tests are ignored by default and need a host and
account you control.

Neither command needs the updater signing key: updater artifacts are produced
only by the release workflow, through `src-tauri/tauri.release.conf.json`. The
release does need `TAURI_SIGNING_PRIVATE_KEY` and a public key committed in
`src-tauri/tauri.conf.json`, and it fails rather than publishing a release the
updater cannot verify.

## Project language

- **Application Update**: a newer Control Room published to GitHub Releases,
  cryptographically signed and verified before it is installed. It replaces the
  app on this Windows machine and never touches a Remote Host. Distinct from
  anything installed on a Linux host, which Control Room does not manage.
- **Saved Connection**: a reusable SSH destination and username, with optional
  port or identity-file overrides.
- **Connection Group**: a local, manually ordered Saved Connection section. A
  Saved Connection belongs to at most one group; Ungrouped is derived.
- **Connection Tag**: reusable local metadata attached to Saved Connections for
  filtering. Tags do not grant permissions or trigger operations.
- **Remote Host**: the Linux system reached through a connection. Several
  connections can point at one host.
- **Workspace**: an open view of one target that groups a Terminal Session with
  whatever else that target supports. A remote Workspace is a Saved Connection
  plus the inspection views; a local Workspace is a Local Shell Profile and its
  terminal, and nothing else. One target can have several Workspaces.
- **Local Shell Profile**: one of the four Windows shells Control Room can host,
  identified by a stable id (`powershell-7`, `windows-powershell`,
  `command-prompt`, `git-bash`). The id is the only part the frontend may send
  back, and a profile that is not installed is never offered.
- **Terminal Session**: one interactive shell inside a Workspace, an SSH shell on
  a Remote Host or a local Windows shell. Its state belongs to the session, not
  to the connection. A remote session connects and disconnects; a local one runs
  and stops.
- **Structured Operation**: a bounded, read-only inspection request that runs
  independently of Terminal Sessions.
- **Systemd Unit**: a canonical system-scope service, timer, mount, or socket
  returned by the bounded Systemd inspection.
- **Listening Socket**: one TCP or UDP listener returned by a manual, bounded
  host snapshot. Kernel socket facts remain separate from correlated ownership.
- **Container Inspection**: a timestamped, in-memory detail record collected by
  full Docker ID without lifecycle controls or raw inspect JSON in React.
- **Scratchpad Note**: user-authored plain text stored locally for one Saved
  Connection or shared globally across the app. It is not encrypted secret storage.
- **Boot Diagnostic**: a timestamped, in-memory investigation of one validated boot ID
  with independently fallible timing, unit, and bounded journal evidence.
- **Log Stream**: a live journald or Docker log reader with its own lifecycle,
  held in memory.
- **Enhanced History**: a local record of commands the installed Bash integration
  reports. It does not import the host's existing shell history.
- **Host Baseline**: an explicit, timestamped capture of normalized host state
  for one Saved Connection, versioned by schema and split into sections that
  each record their own collection time and support status.
- **Normalized Host State**: the versioned section, entry, and fact shape a
  baseline stores. Entries carry a domain-aware identity so two captures can be
  compared without per-section diff code.
