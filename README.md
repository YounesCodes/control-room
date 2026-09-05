# Control Room

> A Windows SSH client with read-only Linux host inspection.

[![Latest release](https://img.shields.io/github/v/release/YounesCodes/control-room?display_name=tag)](https://github.com/YounesCodes/control-room/releases/latest) [![CI](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/YounesCodes/control-room/actions/workflows/ci.yml)

Control Room is a local Windows desktop application for working with Linux machines over SSH. It gives you a real interactive shell and a set of bounded, read-only views for the same Remote Host: system details, boot evidence, systemd units, listening ports, journald, Docker containers, logs, and opt-in Bash command history.

It also opens shells on the Windows machine it runs on. PowerShell 7, Windows PowerShell, Command Prompt, and Git Bash appear as Local Terminal Workspaces in the same terminal, with the same fonts, colours, splits, and tabs as an SSH session.

It is for people who manage Linux machines from Windows and want host context close to their terminal work. Control Room is not a monitoring service, RMM tool, server control panel, web dashboard, cloud platform, SSH replacement, or AI tool. The terminal remains the place where you perform administrative work.

## What the app looks like

The main window has a Connections rail on the left, Workspace tabs across the top, and a main pane that changes between Terminal, Overview, Systemd, Ports, Docker, Boot, Logs, Baselines, and Enhanced History. A Workspace belongs to either one Saved Connection or one local shell. You can open several Workspaces, including several for the same connection or the same shell, then focus or split terminal sessions when you need to compare hosts. A local shell and an SSH session can share one split.

## Why Control Room?

A normal Windows terminal gives you a shell after you run `ssh`. You then type the inspection commands yourself and keep the results in a scrollback buffer.

Control Room keeps that shell, then adds a small set of structured views around the same connection:

```text
Saved Connection
    |
    +-- Workspace
         +-- Interactive SSH terminal
         +-- Host overview
         +-- systemd units
         +-- listening TCP and UDP ports
         +-- Docker containers
         +-- Boot diagnostics
         +-- journald and Docker logs
         +-- host baselines and comparisons
         +-- Enhanced History, when enabled

Local shell
    |
    +-- Workspace
         +-- Interactive Windows terminal
```

The distinction matters. Control Room helps you inspect and move between related views. It does not try to replace OpenSSH or turn a local desktop client into a remote administration platform.

## Features

### Workspaces and SSH

- Save an SSH destination, required username, and optional port or existing identity-file override as a Saved Connection.
- Open multiple independent Workspaces and multiple Terminal Sessions for one Saved Connection.
- Use an interactive terminal backed by the Windows OpenSSH client and ConPTY, with resizing, scrollback, Unicode, ANSI and VT output, copy and paste, and control keys.
- Reconnect a dropped Terminal Session, clear its local display, or focus and split terminal panes.
- Restore Workspace tabs and layout after restarting the app. Restored Workspaces start disconnected and never reconnect automatically, and a restored local tab starts no process until you ask.

### Local Terminal

- Open a shell on the Windows machine running Control Room, in the same integrated terminal as an SSH session: interactive input and output, resize, Unicode, ANSI and VT output, copy and paste, scrollback, and your terminal font and colour settings.
- Supported shell profiles: PowerShell 7 (`pwsh.exe`), Windows PowerShell, Command Prompt, and Git Bash (`bash.exe`, as a login shell).
- Only shells that are actually installed are offered. Control Room looks in the standard Windows install locations, and on `PATH` for PowerShell 7 and for a Git for Windows directory.
- Shells start with your normal Windows environment, in your user profile directory.
- Run several local terminals at once, mix them with SSH terminals, split them side by side, rename their tabs, stop one without touching the others, and restart one after its shell exits.
- Local Workspaces are terminal-only. There is no local host inspection, no Windows service or process view, and no local command history.
- Control Room is the terminal emulator. It does not launch or embed Windows Terminal, and it never opens an external terminal window.

### Host inspection

- View the hostname, operating system, kernel, architecture, uptime, default shell, and detected runtime capabilities.
- Watch CPU busy share and memory in use while the Overview pane is open, each a current reading
  over a sparkline of the recent window. Sampling reads only `/proc`, pauses on request, stops when
  you navigate away or the window is hidden, and keeps nothing: there is no agent, no schedule that
  outlives the pane, and no stored history. A reading the host did not return is shown as
  unavailable rather than as zero.
- Inspect system-scope systemd services, timers, mounts, and sockets. Failed units sort first,
  active and failed totals remain visible, and state and type filters narrow the list. Each unit
  keeps its canonical identity and can open its journal.
- Inspect a timestamped snapshot of listening TCP and UDP sockets across four tabs: a visual
  Overview graph (host to listener to owning service or process, with exposure and UFW firewall
  annotations), Connections (established connections aggregated by listener), Docker (published
  host-to-container port topology), and a precise, searchable Table. Filter by protocol, exposure,
  and text; binding exposure and firewall policy are reported separately, and a broad bind is never
  presented as Internet reachability. Process details stay unavailable when the remote account
  cannot read them, and navigation appears only for explicit ownership evidence.
- Group Docker Compose containers by project and service, switch to a flat list, search by
  project, service, name, image, or ID, inspect each container, and open its logs. Containers
  without valid Compose identity labels stay under Ungrouped.
- Inspect one container by its full Docker ID across Overview, Ports, Networks, Mounts, and
  Metadata sections. The inspector separates image references from content IDs and reports
  state, health, lifecycle times, restart policy, published ports, network addresses, mount
  destinations, and validated Compose identity. It does not collect environment values,
  command arguments, arbitrary labels, health logs, or host mount sources.
- Inspect the current or one of the nine most recent previous boots on demand. Boot Diagnostics
  shows available timing, up to 20 slow-unit observations, current failed units, and up to 30
  warning-through-alert journal entries with per-section timestamps and availability errors.
- Reuse recent inspection results briefly and refresh them manually when you need current data.

All structured inspection is read-only. Control Room does not scan networks, test reachability, or start, stop, restart, reset, create, or remove units or containers.

### Host baselines

Capture a timestamped record of the current host facts, systemd units, containers, listening
sockets, and filesystems, then compare two captures to see what changed.

Capture runs only when you select Capture baseline. There is no timer, no agent, and no background
collection. Tick the sections you want before you start. Progress is reported one section at a
time, and Stop ends the capture once the section in flight returns, keeping everything read up to
that point.

Each section records its own collection time and one of five states: collected, partial, not
present, not readable, or not captured. Those stay distinct. A section left out of the capture, or
one Control Room could not read, is reported as incomparable rather than counted as unchanged, so a
comparison never implies a quiet host from missing evidence.

Each section also carries its own schema version, so changing what one section records leaves the
others comparable against older captures.

Open a capture on its own and any section that read something expands to the entries it recorded,
with a filter once the list is long. From an entry you can read that one unit, port, or mount
across every stored capture, which answers when a value moved rather than only whether it did.

You can compare the selected capture against another capture, or against the live machine state.
The live comparison reads the host the same bounded way a capture does, then throws the read away:
it answers "what has changed since then" without adding a capture you did not ask to keep. Read
again repeats the read, and Stop ends it once the section in flight returns.

A comparison lists additions, removals, and changed values with both the old and new value, keyed
by systemd unit id, container name, socket address, or mount point. It draws no conclusion about
why a value moved. Fields that move on their own, such as a systemd sub-state or a container state,
are hidden by default so routine churn does not bury the rest; one checkbox brings them back. Copy
puts the comparison on the clipboard as Markdown, and Markdown or JSON writes it to a file. Machine identity comes from a fingerprint the host computes itself, and the
comparison says plainly when two captures came from different machines, when the live host answers
as a different machine than the capture came from, or when identity could not be read at all.

Baselines are stored locally as normalized facts only. Name, pin, compare, and delete them from the
Baselines view. Each row says how many entries differ from the capture below it. Control Room keeps
the 20 most recent captures per Saved Connection and drops the oldest beyond that. Pinning a
capture keeps it past that limit and stops it using one of the 20 slots, so a named baseline is
never evicted by routine captures. Deleting a Saved Connection deletes its baselines.

### Logs

- Read journald output for a selected systemd unit or Docker output for a selected container.
- Choose a tail size, follow a live stream, pause or resume rendering, stop a stream, and clear the view.
- Search the lines already loaded in the current view.
- Keep each Log Stream independent and in memory. Control Room does not persist fetched logs.

### Enhanced History

Enhanced History is an opt-in Bash integration, not an import of the remote account's existing shell history.

When enabled, Control Room installs a marked block in the remote account's `~/.bashrc` and a script under `~/.local/share/control-room/`. Integrated Bash sessions report the command, working directory, timestamps, and exit code back to Control Room. The app records those entries locally, where you can search, copy, paste, delete, clear, pause, disable, or remove the integration.

Capture starts only in sessions opened after you enable it. Control Room does not infer commands from keystrokes or read `.bash_history`. Command lines may contain secrets, so enable this only when that local record is appropriate for your work.

### Productivity

- Organize Saved Connections into collapsible groups, manage reusable color-coded tags beside
  those groups, and assign existing tags from each connection editor. Filter the sidebar by
  connection name, SSH target, group, or tag.
- Use the command palette to open connections, switch views, change Workspaces, reconnect, and open Settings.
- Keep one plain-text Scratchpad note per Saved Connection and one global note shared across every
  connection and Workspace. Closing a Workspace does not delete either note.
- Tune terminal font, size, scrollback, colors, right-click paste, log tail defaults, the global
  Enhanced History setting, and whether Structured Operations may use sudo. Terminal settings apply
  to local and SSH terminals alike.

### Updating Control Room

Control Room checks its own GitHub Releases for a newer version about ten seconds after it starts, and twice a day while it stays open. When one exists, the titlebar shows a quiet **Update available** next to the Settings button. Nothing appears while you are up to date.

Selecting it opens a small panel with the version and that release's notes. Nothing is downloaded until you ask. The download runs in the background, so SSH terminals, local terminals, and log streams keep working while it happens; the titlebar shows progress and then **Restart to update**.

Installing is explicit and always confirmed, because it closes and reopens the app. Active Terminal Sessions and Log Streams end when it does, and restored Workspaces come back disconnected exactly as they do after any restart. Control Room never reconnects them for you. After the new version starts, it shows what changed once.

Settings has a **Control Room updates** section with the running version, an **Automatically check for updates** preference that is on by default, and a manual **Check for updates** that keeps working when the automatic one is off.

This updates Control Room on your Windows machine. It never installs, upgrades, or changes anything on a Remote Host.

## Read-only by design

Structured Operations use bounded, noninteractive SSH commands to read the Remote Host. They do not edit remote files, transfer files, install packages, manage services, manage containers, or run a monitoring loop. If you need to change the machine, use the interactive terminal with the permissions of the connected account.

Enabling Enhanced History is the explicit exception to the inspection-only rule. It changes the remote account's Bash startup configuration only when you ask it to, and the same screen can remove that integration.

## Elevated commands

Some reads need root. Socket ownership, firewall policy, and the Docker daemon are the usual ones, and without privilege they come back partial or refused.

Sudo is off until you allow it. Settings has one switch that covers every Saved Connection, and each connection editor has one for a single host. While the global switch is on, the per-host checkbox is locked and says so; each host keeps its own value, so turning the global switch back off restores what it had.

Allowing sudo does not start asking for passwords. An allowed read checks the host first and elevates only when the account already has passwordless sudo. On every other account the same read runs unelevated, and when it hits a permission error the pane offers **Retry with sudo** the way it always has. That one-shot password works whether or not sudo is allowed, and it is used once and discarded. Elevation only widens what a read can see. It never lets a Structured Operation change the machine.

Because the allowance only bites where sudo asks no questions, Control Room tells you which kind of account you have. Overview reports sudo as `Passwordless` or `Password required` beside systemd, journald, and Docker, and **Test structured access** reports it in the connection editor. A Docker daemon that answers only under sudo shows as reachable with sudo rather than as unavailable.

## Support

| Where                        | Support                                                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local machine                | Windows 11 x64                                                                                                                                                                            |
| SSH client                   | The Windows OpenSSH client already installed on the machine                                                                                                                               |
| Structured remote inspection | Debian or Ubuntu family Linux with systemd, journald, Bash, and `ss` from iproute2                                                                                                        |
| Docker inspection            | Optional Docker installation on the remote host. The connected account must be able to query the Docker daemon, or you can allow sudo for the host and retry a read-only request with it. |
| Other Linux hosts            | Terminal-only, best effort. The structured views target the environment above.                                                                                                            |

## Install

The current published release is [v0.7.0](https://github.com/YounesCodes/control-room/releases/tag/v0.7.0). Download the latest Windows installer from [GitHub Releases](https://github.com/YounesCodes/control-room/releases/latest), run it, and start Control Room.

The installer is an unsigned, per-user NSIS package. Windows may show an unrecognized-publisher warning. The release includes a SHA-256 checksum beside the installer.

Control Room can update itself from inside the app, but only from a version that already has the updater. v0.6.1 and earlier were published before it existed, so they cannot learn about it: upgrading from one of those means downloading the newer installer from GitHub Releases and running it once, by hand. Every release after that one can be installed from inside the app.

After launch:

1. Select **Add connection**.
2. Enter a display name, an SSH destination, and a username. Add a port or existing private-key path only when you need an override.
3. Select the Saved Connection to open a Workspace.
4. Select **Test structured access** in the connection dialog if you want to check the noninteractive authentication required by the inspection views.

## SSH expectations

Control Room uses the OpenSSH client already installed on Windows. It uses the normal Windows OpenSSH configuration and can detect a local `ssh-agent` with loaded identities. An identity-file override points to a key in its existing location. Control Room does not copy or import that key.

The interactive terminal uses normal OpenSSH behavior, including its prompts. Structured Operations use noninteractive OpenSSH mode, so they require public-key authentication or an agent identity that can connect without prompting for a password. If structured access fails, the interactive terminal may still work with a password.

## Security and local data

Control Room keeps its local state in SQLite. It stores:

- Saved Connection details, including the destination, username, optional port, optional identity-file
  path, group, and color-coded tags. Group order and collapse state are local too.
- Application settings and disconnected Workspace layout.
- User-authored connection and global Scratchpad notes. These are ordinary local data, not
  encrypted secret storage.
- Cached host capability data such as the operating system and detected service or container counts.
- Enhanced History entries only when you enable capture. Each entry can include the command, working directory, timestamps, and exit code.
- Host baselines you capture: normalized section facts, per-section collection time and status,
  your label, the schema version, and host identity evidence including a hostname and a machine
  fingerprint the host hashes itself.

It deliberately does not persist:

- SSH passwords or sudo passwords.
- Imported or copied private keys.
- Terminal output.
- Fetched journald or Docker logs.
- Boot diagnostics and journal samples.
- Update installers. A downloaded update is held in memory until you install it and is never written
  to the database. Closing Control Room before installing simply means downloading it again.

The one thing the updater stores is a small note recording the version and release notes of an update about to be installed, so the new version can show what changed once. It is written just before the installer runs, read only when its version matches the version now running, and deleted as soon as you dismiss the dialog or when it turns out not to match.

### What "signed" means here

Update packages are cryptographically signed, and Control Room verifies that signature against a public key built into the application before it installs anything. A package that fails verification is rejected outright; there is no way to install it anyway.

That is not the same as Windows Authenticode code signing. The installer itself is still unsigned at the Windows publisher level, so Windows may still warn about an unrecognized publisher. The updater signature protects the update channel, not the reputation of the download.

Control Room contains no GitHub token, API key, or release credential. The updater reads one fixed, public release URL and nothing else.

Allowing sudo stores a permission, never a credential. When a read-only request needs a sudo password, Control Room sends it once for that retry and then discards it. The terminal itself is a normal SSH shell, so commands run there have the effects allowed by the remote account.

## Keyboard shortcuts

| Shortcut       | Action                                      |
| -------------- | ------------------------------------------- |
| `Ctrl+Shift+P` | Open the command palette                    |
| `Ctrl+Shift+T` | Switch the active Workspace to its Terminal |
| `Ctrl+Shift+R` | Reconnect or restart the active Terminal    |
| `Ctrl+Shift+W` | Close the active Workspace                  |

## Development

Control Room uses a Tauri desktop shell, a React and TypeScript frontend, and a Rust backend. The backend owns native process management, SQLite, SSH argument construction, remote command construction, and local shell discovery and construction. React can ask for a validated Local Shell Profile id; there is no API for running an arbitrary command, locally or remotely.

### Prerequisites

- Windows 11 x64
- Node.js 22 or newer
- Rust stable with the MSVC target
- Visual Studio C++ Build Tools and the Windows SDK
- WebView2 Runtime
- The Windows OpenSSH Client optional feature

Install the locked JavaScript dependencies and start the development app:

```bash
npm ci
npm run tauri dev
```

Run the local validation gate:

```bash
npm run check
```

This checks synchronized versions, formatting, ESLint, frontend tests and build, Rust formatting, Clippy, and Rust tests. Live SSH tests are ignored by default and require a host and account that you control.

Build the Windows installer locally with:

```bash
npm run tauri build
```

The build produces an unsigned per-user NSIS installer under `src-tauri/target/release/bundle/nsis/`.

## Releases

GitHub Actions validates pushes and pull requests on Windows. CI runs the frontend and Rust checks, audits the locked Rust dependencies, builds the NSIS installer, and publishes a SHA-256 checksum as an artifact.

Release tags use the `v*` pattern. The version in the tag must match `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`. A valid tag runs the release gate and publishes to a GitHub release:

| Asset                                         | Purpose                                |
| --------------------------------------------- | -------------------------------------- |
| `Control.Room_<version>_x64-setup.exe`        | The per-user NSIS installer            |
| `Control.Room_<version>_x64-setup.exe.sig`    | Updater signature, verified by the app |
| `Control.Room_<version>_x64-setup.exe.sha256` | Checksum for a manual download         |
| `latest.json`                                 | The updater feed installed copies read |

The release workflow refuses to start when the updater signing key is missing or the public key is absent from `src-tauri/tauri.conf.json`, and it fails after the build if any of those four assets is missing or if `latest.json` announces a version other than the tag. A release that the updater cannot consume is treated as a failed release.

### Updater signing key

The signing key is a deployment prerequisite, generated once and never committed:

```bash
npm run tauri signer generate -- -w .tauri/control-room.key
```

- The **public** key it prints goes in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, committed. It is the trust anchor built into every installed copy, so keeping it in version control makes changes to it reviewable.
- The **private** key goes in the `TAURI_SIGNING_PRIVATE_KEY` repository secret. It must never be committed, logged, or attached to a build.
- If you set a password on the key, it goes in the `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secret.

`.tauri/` is ignored by git. Ordinary development does not need any of this: `npm run check` and `npm run tauri build` never touch the signing key, because updater artifacts are produced only by the release workflow through `src-tauri/tauri.release.conf.json`.
