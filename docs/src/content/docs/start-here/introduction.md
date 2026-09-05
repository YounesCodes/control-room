---
title: Introduction
description: What Control Room is, who it is for, and where its boundary sits.
---

Control Room is a Windows desktop app for working with Linux machines over SSH. It gives you a real interactive SSH terminal and a set of structured views for the Remote Host behind that connection.

## What it adds to SSH

Open a Saved Connection and you can move between:

- an interactive SSH terminal
- host capabilities and current load readings
- system-scope systemd units
- bounded TCP and UDP listener snapshots
- Docker containers and published ports
- current and recent boot evidence
- journald and Docker log streams
- explicit host baselines and comparisons
- optional Bash command history

The views share a Workspace, but they do not share terminal output or turn the terminal into a command runner. The terminal remains the place for administrative work.

## Local terminals too

Control Room can host an installed PowerShell 7, Windows PowerShell, Command Prompt, or Git Bash session. These are terminal-only Local Workspaces. They use the same tabs, splits, font, colors, and scrollback as SSH sessions, but they never run remote inspection and never record command history.

## What Control Room does not do

Control Room is not an RMM tool, monitoring service, server control panel, cloud dashboard, SSH replacement, or service manager. It has no file transfer, remote file editor, package updater, container lifecycle controls, host discovery, background agent, or private-key store.

Next: [Install Control Room](/control-room/start-here/installation/). For the support boundary, read [Requirements](/control-room/start-here/requirements/).
