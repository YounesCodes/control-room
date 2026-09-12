---
title: Security
description: Understand the read-only boundary, sudo behavior, authentication, and local storage.
---

Control Room keeps native process management, SQLite, SSH argument construction, remote command construction, and local shell discovery in Rust. The React frontend can select a validated Local Shell Profile id, but it cannot provide an arbitrary executable, script, or argument list.

## Read-only structured operations

Structured operations use bounded, noninteractive SSH commands. They read systemd, journald, Docker, socket, filesystem, and boot facts. They do not edit remote files, transfer files, install packages, manage services or containers, scan networks, or run a background agent.

The interactive terminal is different. Commands typed there run with the permissions of the remote account and have the normal effects of an SSH shell.

## Elevated reads

Sudo is off by default. You can allow it globally or for one Saved Connection. When an allowed operation runs, Control Room first checks for passwordless sudo. It uses elevation only when the account can run that read without a password. Otherwise it runs the read unelevated and reports the limitation.

If a read fails because it needs a password, the pane may offer a one-shot sudo retry. Control Room sends the password for that retry and discards it. It is never saved or placed on a command line. The allowance itself never stores a credential and never widens a structured operation beyond reading.

Overview reports passwordless sudo capability separately from the setting that allows elevation. Docker access through sudo is also reported separately from ordinary Docker access.

## Administrator local terminals

Administrator PowerShell and Command Prompt Workspaces use Sudo for Windows in inline mode. Windows shows its UAC prompt before starting the shell. Control Room reads the effective user and machine-policy mode and never enables or reconfigures Sudo.

Inline mode connects the elevated shell to Control Room's existing ConPTY. This also means the unelevated Control Room process can send input to that administrator shell. Only enable inline mode when you accept that trust boundary. The fixed profile id remains the only frontend input. Rust resolves both `sudo.exe` and the selected shell from known Windows locations.

Administrator local terminals are separate from SSH sudo. They can change this Windows machine through commands you type. The read-only Structured Operation rules apply only to Remote Host inspection.

## Stored locally

The SQLite database stores:

- Saved Connection details, groups, tags, and ordering
- application settings and disconnected Workspace layout
- user-authored Scratchpad notes
- cached host capability data
- Enhanced History entries when you opt in
- normalized Host Baselines that you capture
- a small one-time note recording the version an update just installed, so the app can show what changed once

## Never stored

Control Room does not persist:

- SSH or sudo passwords
- imported or copied private keys
- terminal output
- fetched journald or Docker logs
- Boot Diagnostic evidence or journal samples
- update installers, which are held in memory until you install them

Scratchpad notes and connection metadata are local data, not encrypted secret storage. Enhanced History can contain command lines with secrets, so enable it only when that local record is appropriate.
