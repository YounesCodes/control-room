---
title: Control Room
description: A Windows SSH client with read-only Linux host inspection.
---

Control Room is a Windows desktop app for working with Linux hosts over SSH. It pairs a real interactive terminal with read-only views for services, ports, Docker, logs, boot diagnostics, and host state.

## Get started

1. [Install Control Room](/control-room/start-here/installation/) from the latest GitHub release.
2. [Add an SSH connection](/control-room/start-here/quick-start/) and test structured access.
3. Open a Workspace and start in the terminal or an inspection view.

The [requirements](/control-room/start-here/requirements/) page lists the supported Windows, Linux, and Docker environments.

## Using Control Room

- [Connections](/control-room/connections/) — save, group, tag, and test SSH destinations.
- [Terminal](/control-room/terminal/) — the integrated SSH terminal, tabs, and splits.
- [Local terminals](/control-room/local-terminals/) — PowerShell 7, Windows PowerShell, Command Prompt, and Git Bash.
- [Workspaces](/control-room/workspaces/) — sessions, layouts, and what returns after a restart.

## Inspecting hosts

- [Overview](/control-room/inspection/overview/) — host capabilities and live load.
- [Services](/control-room/inspection/services/) — system-scope systemd units.
- [Logs](/control-room/inspection/logs/) — journald and Docker log streams.
- [Ports](/control-room/inspection/ports/) — listener and connection snapshots.
- [Docker](/control-room/inspection/docker/) — containers, Compose groups, and inspection.
- [Boot diagnostics](/control-room/inspection/boot/) — current and recent boot evidence.
- [Baselines](/control-room/inspection/baselines/) — capture and compare normalized host state.

## Tools

- [Enhanced History](/control-room/inspection/history/) — an opt-in record of reported remote Bash commands.
- [Scratchpad](/control-room/inspection/scratchpad/) — plain-text notes per connection or global.

## Reference

- [Settings](/control-room/reference/settings/)
- [Keyboard shortcuts](/control-room/reference/keyboard-shortcuts/)
- [Security](/control-room/reference/security/) — the read-only boundary, sudo behavior, and stored data.
- [Troubleshooting](/control-room/help/troubleshooting/)
- [FAQ](/control-room/help/faq/)

## Development

- [Setup](/control-room/development/setup/) — the toolchain, checks, and installer build.
- [Architecture](/control-room/development/architecture/)
- [Contributing](/control-room/development/contributing/)

Structured inspection is bounded and read-only, and Control Room never persists terminal output, fetched logs, passwords, or private keys. [Security](/control-room/reference/security/) has the full boundary.
