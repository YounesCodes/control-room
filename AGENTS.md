# Control Room

Control Room is a Windows desktop app for opening local shells and inspecting
Linux systems over SSH. The React frontend presents the app; the Rust/Tauri
backend owns native processes, persistence, and remote operations.

## Repository guide

- `src/`: React UI, frontend state, and TypeScript tests.
- `src-tauri/`: Rust backend, Tauri commands, process management, and Rust tests.
- `docs/`: user-facing behavior and troubleshooting.
- `DESIGN.md`: visual language and reusable UI conventions. Exact design token
  values live in `src/styles.css`.
- Tests and implementation are the source of truth for exact feature behavior.
  Update the relevant user documentation when that behavior changes.

Read `DESIGN.md` before making substantial UI changes. Find nearby tests and
existing implementation before changing a feature contract.

## Security and architecture boundaries

- Rust owns process creation, SQLite, SSH and remote-command construction, and
  local-shell discovery. The frontend may request an approved operation or name
  a known Local Shell Profile id. It must never supply an arbitrary program,
  script, or argument list. Rust validates identifiers before using them in a
  command.
- Keep system OpenSSH and ConPTY. SSH and local terminals share the
  `SessionManager` pty lifecycle. Keep SSH-only state and behavior out of local
  sessions. Document the scope decision here before replacing either
  foundation.
- Remote Structured Operations are bounded, read-only, and separate from
  Terminal Sessions. Sudo is off by default; an allowance never expands an
  operation or causes an automatic password prompt. Use it only when the
  account has passwordless sudo; otherwise run the read unelevated. Report
  whether elevation was used and keep host capability distinct from policy
  allowance. Do not scan networks, test reachability, or poll a host. The
  bounded Overview meters are the sole exception: while mounted and visible,
  they may read `/proc` without overlapping requests, storing history, or
  raising alerts.
- Rust returns approved typed records. Collect only fields the feature needs;
  do not pass raw command output or raw Docker inspection data to React for
  parsing, or infer ownership from process names. Treat missing or conflicting
  evidence as unavailable or ambiguous, never as zero, unchanged, or proof of
  cause. Keep bind exposure, firewall policy, and reachability as separate
  claims.
- Never persist terminal output, fetched logs, SSH or sudo passwords, imported
  private keys, or installer bytes. Scratchpad notes are size-bounded, plain
  text, local, user-authored, and never filled from terminal or log output.
  Keep temporary inspection results in Workspace memory unless the user
  explicitly captures a Host Baseline.
- Remote release notes and other service-provided text are untrusted data. Parse
  known shapes and render as text, never as markup. The updater must verify its
  signature; a failed verification is a hard failure.

## State and behavior that must remain true

- Give each Saved Connection, Workspace, Terminal Session, Structured
  Operation, and Log Stream its own ID. A Workspace belongs to exactly one
  typed target: a Saved Connection or a Local Shell Profile. Local Workspaces
  have no remote inspection views or remote-only state. Multiple Workspaces
  may use the same target.
- Persist only Saved Connections and their local organization metadata,
  settings, host capabilities, Enhanced History, Scratchpad notes, Host
  Baselines, and disconnected Workspace layout. Restore Workspaces disconnected;
  do not reconnect remote sessions or start local shells automatically.
- Saved Connection groups and tags are local organization metadata. A
  connection belongs to at most one group; deleting a group returns its
  connections to Ungrouped. Tags grant no access and trigger no operation.
- Enhanced History is opt-in, Bash-only, and based on events reported by the
  installed shell integration.
- Capture Host Baselines only on user request. Preserve distinct states for
  collected, partial, unsupported, unavailable, and skipped sections. A live
  comparison is a read, not a saved capture. Store normalized facts and version
  each section independently, not raw command output.
- Automatic update checks have one application-wide lifecycle. Installing an
  update requires confirmation because it ends active sessions. A manual check
  remains available when automatic checks are off. Keep the updater optional at
  startup. The only durable updater data is the one-time notice for the
  installed version; never persist installer bytes.

Feature-specific interaction rules belong with the relevant code, tests, and
manual pages. A Saved Connection is a reusable SSH destination; a Remote Host
is the Linux system it reaches. A Workspace is one open view of a target, and a
Terminal Session is the shell inside it. A Structured Operation is a bounded
read; Enhanced History is opt-in Bash integration data; a Host Baseline is an
explicit normalized capture. Keep filtered selections honest, navigation and
dialog actions reachable at the minimum window size, and terminal reading
position stable when new log lines arrive. Distinguish missing readings from
failed refreshes and keep the original SSH failure beside Reconnect.

## Working agreements

- Inspect the current diff and preserve existing user changes. Avoid unrelated
  redesign or cleanup.
- Add or update focused tests for behavior changes, including parser, argument
  construction, persistence, and lifecycle regressions where relevant.
- Keep `README.md`, `DESIGN.md`, `docs/`, and this file accurate when behavior or
  project boundaries change.
- Do not commit or push unless the user asks.

## Validation

- Run `npm ci` and `npm run check` before handoff.
- Run `npm run tauri build` when validating the desktop installer or release
  packaging. Live SSH tests require a host and account you control.
- For releases with visible changes, refresh the screenshots in
  `docs/src/assets/screenshots/` from the release build and compare their
  controls, labels, limits, and empty states with the shipped UI.
