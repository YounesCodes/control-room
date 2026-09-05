---
title: Control Room
description: A Windows SSH client with read-only Linux host inspection.
---

Control Room is a Windows desktop app for working with Linux hosts over SSH. It pairs a real interactive terminal with read-only views for services, ports, Docker, logs, boot diagnostics, and host state.

## Get started

1. [Install Control Room](/control-room/start-here/installation/) from the latest GitHub release.
2. [Add an SSH connection](/control-room/start-here/quick-start/) and test structured access.
3. [Open a Workspace](/control-room/workspaces/) and start in the terminal or an inspection view.

## Common tasks

- [Connect to a host](/control-room/connections/) — save and test an SSH destination.
- [Use terminals and splits](/control-room/terminal/) — work in SSH or local Windows shells.
- [Inspect services and logs](/control-room/inspection/services/) — check systemd and journald.
- [Inspect listening ports](/control-room/inspection/ports/) — review bounded network snapshots.
- [Inspect Docker](/control-room/inspection/docker/) — view containers and Compose grouping.
- [Troubleshoot a connection](/control-room/help/troubleshooting/) — work through common failures.

## Learn more

[Introduction](/control-room/start-here/introduction/) · [Requirements](/control-room/start-here/requirements/) · [Security](/control-room/reference/security/)

Structured inspection is bounded and read-only. Control Room never persists terminal output, fetched logs, passwords, or private keys.
