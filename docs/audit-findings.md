# Confirmed audit findings

Reviewed against `main` at `c9134e4` and the current heads of open PRs #24
through #37. PRs #11 and #19 remain outside this audit.

This file contains confirmed defects and integration blockers only. It does not
list deliberate product limits, accepted design decisions, or speculative
problems inferred from old branch commits.

## Cross-branch integration blockers

### PRs #24 through #31 reject databases created by current main

`main` uses SQLite schema version 5. These eight branches still declare an
older `LATEST_SCHEMA_VERSION`:

| PR  | Branch                            | Declared version |
| --- | --------------------------------- | ---------------: |
| #24 | `codex/ssh-effective-config`      |                1 |
| #25 | `codex/service-relationship-view` |                1 |
| #26 | `codex/workspace-presets`         |                2 |
| #27 | `codex/connection-diagnostics`    |                1 |
| #28 | `codex/terminal-context-actions`  |                3 |
| #29 | `codex/host-snapshots`            |                4 |
| #30 | `codex/session-timeline`          |                3 |
| #31 | `codex/cross-host-inspections`    |                3 |

`Database::open` rejects a database when its stored version is newer than the
branch's declared version. A user who has run current `main` therefore cannot
start a dev build from any of these branches with the same application data.

All eight PRs are also currently marked conflicting with `main`. They need a
rebase that preserves migrations 1 through 5. PR #26 must move the
`workspace_presets` migration to the next free version instead of keeping its
current version 2 migration.

### Six new workspace views fail persistence validation

The following branches add a view to the TypeScript `WorkspaceView` type and
navigation, but do not add it to the Rust allowlist in
`validate_workspace_state`:

| PR  | Branch                                  | Missing view  |
| --- | --------------------------------------- | ------------- |
| #30 | `codex/session-timeline`                | `timeline`    |
| #33 | `claude/log-correlation`                | `correlate`   |
| #34 | `claude/service-diagnostics`            | `diagnostics` |
| #35 | `claude/container-image-drift`          | `images`      |
| #36 | `claude/ssh-route-visualization`        | `route`       |
| #37 | `claude/parameterized-command-snippets` | `snippets`    |

Selecting one of these tabs updates the Workspace state. After the 250 ms
debounce, `save_workspace_state` rejects the update with
`Workspace view is invalid`, and the frontend reports that the Workspace layout
could not be saved.

The rejected state is not written to SQLite because validation runs before the
database update. On the next launch, Control Room restores the last valid saved
view rather than the newly selected view.

## Findings on main

### Enhanced History does not arm on Bash 5.0

`src-tauri/src/history.rs` always assigns an array to `PROMPT_COMMAND`. Bash 5.1
introduced the behavior that executes every element of a `PROMPT_COMMAND`
array. On Bash 5.0, only the scalar value, element zero, is used as the prompt
command.

Control Room places `__control_room_precmd` first and
`__control_room_prompt_complete` last. Bash 5.0 never runs the completion hook,
so `__control_room_ready` remains `0` and the DEBUG trap never starts command
capture. Enhanced History therefore records no commands on Bash 5.0.

The version boundary is documented in the
[GNU Bash 5.1 release notes](https://lists.gnu.org/archive/html/info-gnu/2020-12/msg00003.html).

### A Log Stream can report stopped before its final stdout bytes arrive

`StreamManager::start` starts separate stdout and stderr reader threads. The
monitor thread joins the stderr reader when the child exits, but it does not
retain or join the stdout reader handle before removing the stream and emitting
`stream-state-changed` with a stopped state.

The frontend handles that stopped event by finalizing its text decoder and
setting the stream status to stopped. Bytes still buffered in the stdout pipe
can then arrive through the channel after the stopped event. This makes the
stream lifecycle event race with its final output and can append log text after
the UI says the stream has stopped.

### The per-connection operation limit can split into two counters

`RemoteOperationPermit::drop` decrements the active count to zero, releases the
per-host lock, and only then locks the hosts map to remove the idle entry.

In that gap, another thread can clone the existing `HostOperationLimit` from
the map without incrementing its count yet. The drop handler then observes zero
and removes the entry. A third thread creates a new `HostOperationLimit` for the
same connection while the second thread starts using the old one. The two
independent counters can each admit operations, exceeding the intended limit of
two structured operations per connection.

## Branch-specific defects

### PRs #24 and #36 run user-configured `Match exec` commands during inspection

Both the Effective Configuration and SSH Route features invoke `ssh.exe -G`.
OpenSSH documents that `-G` evaluates `Host` and `Match` blocks, and that a
`Match exec` condition executes its command under the user's local shell.

Opening or refreshing either inspection can therefore run commands already
present in the user's SSH configuration. This is OpenSSH behavior, not a shell
injection created by Control Room, but the UI presents the action as local
configuration inspection without disclosing the possible local side effect.

See the OpenBSD manual entries for
[`ssh -G`](https://man.openbsd.org/ssh.1#G) and
[`Match exec`](https://man.openbsd.org/ssh_config.5#Match).

### PR #25 offers journal navigation for unsupported related unit types

The relationship parser accepts targets, slices, scopes, devices, and other
systemd unit types. A user can select those related nodes in `ServicesPane`,
which renders the `View journal` action for every selected node.

Journal streaming uses the narrower `validate_systemd_unit_id`, which accepts
only services, sockets, mounts, and timers. Selecting `View journal` for a
related target or slice navigates to Logs and then fails backend validation with
`Invalid systemd unit identifier`. This is a handled validation error, not a
panic, but the UI offers an action that cannot succeed.

### PR #29 changes mount-point identity by collapsing repeated spaces

`parse_filesystem` reads the mount point from `df -P -T` output with
`split_whitespace().skip(6).join(" ")`. This preserves ordinary mount points
that contain a single space but collapses consecutive spaces into one.

Because the mount point is the filesystem identity used by snapshot comparison,
a path such as `/srv/data  share` is stored as `/srv/data share`. That can create
false snapshot differences or make distinct paths compare as the same mount.

### PRs #31 and #32 keep collecting after their dialogs close

`CrossHostDialog` and `HostDiffDialog` expose Stop buttons that call their Rust
cancellation commands. Their modal `onClose` handlers do not call those commands,
and neither component has an unmount cleanup that cancels the active run.

Closing either dialog through its close button, Escape, or the backdrop removes
the UI while the backend run continues. PR #31 continues queued targets as well
as the commands already in flight. PR #32 continues later collection sections
after the current section finishes. The permits are eventually released, but
the app keeps contacting hosts and consuming operation capacity after the user
has dismissed the run.

### PR #34 can mix diagnostics from two rapidly selected units

`DiagnosticsPane` starts a sequential `runAll(unit)` loop whenever `unitId`
changes. Each section guards its own result with an operation ID, but changing
the unit does not cancel the old loop or give the full loop a generation ID.

An old loop can resume after a newer unit has started or completed and launch
its next section. That new operation ID replaces the newer unit's section state,
allowing journal, dependency, or listener data from the previous unit to appear
under the current unit selection.

## Confirmed issue summary

| Location         | Confirmed issue                                                                        |
| ---------------- | -------------------------------------------------------------------------------------- |
| PRs #24-#31      | Old schema limits reject a schema-v5 database; all eight PRs conflict with `main`      |
| PRs #30, #33-#37 | New view names are missing from backend Workspace validation                           |
| `main`           | Enhanced History never arms on Bash 5.0                                                |
| `main`           | Log Stream stopped events can precede final stdout delivery                            |
| `main`           | The operation limiter can create two counters for one connection                       |
| PRs #24 and #36  | `ssh -G` can execute user-configured local `Match exec` commands without UI disclosure |
| PR #25           | Journal action is offered for related unit types the backend rejects                   |
| PR #29           | Filesystem parsing collapses repeated spaces in mount points                           |
| PRs #31 and #32  | Closing a running dialog does not cancel backend collection                            |
| PR #34           | Old unit requests can overwrite sections for the current unit                          |
