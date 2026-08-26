# Control Room MVP product specification

Control Room is a local Windows desktop application for managing Linux systems over SSH. It has no account, cloud backend, required telemetry, or remote Control Room service.

## Supported systems

- Windows 11 x64 desktop
- Windows system `ssh.exe`, OpenSSH configuration, known hosts, and existing identity files
- Debian and Ubuntu family Linux hosts for structured inspection
- systemd, journald, Bash, and a standard POSIX userland
- Docker when installed
- Other Linux systems as terminal-only, best effort

## MVP

### Saved Connections and Workspaces

- Add, edit, delete, search, connect, disconnect, and reconnect Saved Connections
- Store a display name, SSH destination, and required username, with optional port and existing identity-file overrides
- Preserve normal OpenSSH resolution for the port and identity when an override is absent
- Open multiple simultaneous Workspaces, including several for one Saved Connection
- Open another Terminal Session for the active Saved Connection from the Workspace tab rail or with Ctrl+Shift+N
- Let OpenSSH and the Remote Host accept or reject each independent session instead of guessing a connection limit
- Confirm before closing a connected Workspace
- Never reconnect automatically after application restart

### Terminal

- Render a fully interactive OpenSSH shell through ConPTY and xterm.js
- Preserve terminal bytes, ANSI and VT sequences, Unicode, resizing, scrollback, copy and paste
- Support control keys, interactive SSH and sudo prompts, Vim, Nano, top or htop, and tmux
- Keep every advertised PTY row visible, including the bottom status line in full-screen tools such as htop
- Preserve scrollback after connection loss and offer reconnect, a local full-buffer clear, or close
- Focus the active Terminal Session with F11 or a tab-strip control, leaving the terminal, open Workspace tabs, and window controls visible
- Split the focused pane vertically or horizontally with either an existing Terminal Session or a new Terminal Session for any Saved Connection
- Keep nested panes inside the available terminal area, label every pane, and reuse existing sessions without starting duplicate SSH processes

### Overview

- Show resolved connection details, hostname, distribution, version, kernel, architecture, uptime, shell, systemd and journald availability, Docker availability and version, service count, and container count
- Cache results and allow an explicit refresh
- Degrade each capability independently

### Services

- List and search systemd services
- Show load, active, substate, description, and unit-file state
- Open related journal logs
- Never start, stop, restart, enable, or disable services

### Docker

- Detect Docker and daemon permission independently
- List running and stopped containers with ID, name, image, state, status, ports, and creation time
- Open container logs
- Never start, stop, kill, remove, or otherwise manage containers

### Logs

- Tail 50, 100, 200, 500, or 1000 journald or Docker lines
- Follow live output, pause and resume rendering, stop the remote stream, clear the view, and search loaded lines
- Keep every Log Stream independent from Terminal Sessions and other streams
- Never persist fetched logs

### Structured sudo

- Run read-only Structured Operations as the configured user first
- Offer an explicit sudo retry only after permission denial
- Never save or log the sudo password
- Clear the frontend value immediately and zero the Rust-side buffer where practical

### Enhanced History

- Install Bash integration only after explicit user consent
- Report exact commands, working directory, timestamps, exit status, Saved Connection, and Terminal Session
- Never infer commands from keystrokes or import existing Bash history
- Preserve existing Bash startup behavior and support clean, idempotent removal
- Store at most 50,000 searchable entries per Saved Connection, deleting the oldest first
- Offer global and per-Saved-Connection disable, per-Workspace pause, individual deletion, and per-connection clearing
- Warn that command lines may contain secrets
- Never store command output

### Settings and packaging

- One finished black-and-white dark theme with green, amber, and red reserved for status, warning, failure, destructive actions, and terminal ANSI output
- A frameless Windows window with drag, minimize, maximize or restore, and close controls integrated into the application header
- Terminal font family, size, scrollback, and configurable foreground plus ANSI red, green, yellow, blue, magenta, and cyan colors
- Default log tail count
- Detected SSH executable and configuration paths
- Global History setting
- Per-user NSIS installer without an updater or code signing in the private MVP

## Non-goals

- File transfer, remote file browsing, or file editing
- Kubernetes, Proxmox, cloud-provider, RDP, WinRM, PowerShell-remoting, tunneling, or port-scanning interfaces
- Monitoring graphs, alerting, notifications, package management, or remote software updates
- Service or container management actions
- Docker Compose UI
- Accounts, cloud sync, collaboration, AI assistance, mobile support, or automatic discovery
- Arbitrary remote file logs outside journald and Docker
- Imported or pasted private-key storage
- Light theme, automatic updater, or public code signing

## Release acceptance

A clean Windows 11 user can install Control Room, add three Saved Connections, use existing OpenSSH identities, open several interactive terminals, inspect host information, systemd, journald, and Docker, follow independent logs, opt into Bash Enhanced History, search prior commands after an application restart, and uninstall the application. Failure, unsupported, permission, authentication, empty, and connection-loss states remain distinguishable.
