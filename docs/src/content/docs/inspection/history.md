---
title: Enhanced History
description: Opt in to a reversible Bash integration that records reported remote commands locally.
---

Enhanced History is an opt-in integration for remote interactive Bash sessions. It is not an import of the account's existing `.bash_history`.

## Enable it

Enable History for a Saved Connection, or enable the global setting for all connections. Control Room installs a marked block in the remote account's `~/.bashrc` and a script under `~/.local/share/control-room/`.

Only sessions opened after the integration is enabled report entries. The integration reports:

- the command line
- working directory
- start and finish times
- exit code

The app stores those entries locally. You can search, copy, paste, delete, clear, pause capture for a Workspace, disable capture, or remove the integration.

## Remove it

Remove the integration from the History view. Control Room removes only its marked block and integration file. If several Saved Connections use the same remote account, removing it affects capture for those connections and the UI warns you first.

## Limits and risk

Enhanced History is Bash-only and remote-only. It does not infer commands from keystrokes, read existing history, or record local shells. Command lines may include secrets. Treat the local database as sensitive user data even though it is not an encrypted secret store.
