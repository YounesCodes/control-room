---
title: Requirements
description: What you need on your client and the SSH host.
---

Control Room runs on Windows 11 x64 and uses the Windows OpenSSH Client. Local terminals use installed PowerShell 7, Windows PowerShell, Command Prompt, or Git Bash.

The macOS preview runs on Intel and Apple Silicon Macs with macOS 12 or newer. It uses the included OpenSSH client and installed zsh, Bash, or fish shells. See [Install and update](/control-room/start-here/installation/#macos-preview).

For an SSH terminal, you need a Linux host or a Windows 10 or 11 host with OpenSSH Server that accepts your SSH login. Windows shell detection requires noninteractive key or agent authentication. See [Connections](/control-room/connections/) to choose installed Windows shells, Windows Terminal profiles, or WSL distributions.

Linux inspection views need their own tools: systemd for services and boot information, journald for service logs, `ss` for ports, and Docker for containers and their logs. Bash is needed only for optional command history. A host can support some views even when others are unavailable.

The terminal can use normal OpenSSH password prompts. Inspection reads run separately and cannot ask for an SSH password. Use a key or an SSH agent for those reads. A key path in Control Room points to your existing file; the app does not copy it.

Windows inspection uses Windows PowerShell and the built-in networking and CIM commands for services, ports, TCP peers, and resource readings. Docker requires a Windows `docker.exe` on PATH or in Docker Desktop's standard installation directory, plus daemon access for the SSH account. Control Room does not start Docker or inspect Docker installed only inside WSL.

Docker inspection also needs an account that can read the Docker daemon. On Linux, if access requires sudo, you can allow a read-only retry.

## Structured remote inspection

Control Room recognizes these distribution families:

| Distribution                   | Overview | Systemd                 | Ports                                       | Docker         | Boot                      | Logs               | Baselines                                        |
| ------------------------------ | -------- | ----------------------- | ------------------------------------------- | -------------- | ------------------------- | ------------------ | ------------------------------------------------ |
| Debian and Ubuntu              | Yes      | With systemd            | With iproute2                               | When installed | With systemd and journald | journald or Docker | Available sections are captured                  |
| Rocky Linux and AlmaLinux      | Yes      | With systemd            | With iproute2; firewalld numeric port rules | When installed | With systemd and journald | journald or Docker | Available sections are captured                  |
| Oracle Linux and CentOS Stream | Yes      | With systemd            | With iproute2; firewalld numeric port rules | When installed | With systemd and journald | journald or Docker | Available sections are captured                  |
| Amazon Linux 2023              | Yes      | With systemd            | With iproute2; firewalld when installed     | When installed | With systemd and journald | journald or Docker | Available sections are captured                  |
| Fedora Server                  | Yes      | With systemd            | With iproute2; firewalld numeric port rules | When installed | With systemd and journald | journald or Docker | Available sections are captured                  |
| openSUSE Leap                  | Yes      | With systemd            | With iproute2; firewalld when installed     | When installed | With systemd and journald | journald or Docker | Available sections are captured                  |
| Arch Linux                     | Yes      | With systemd            | With iproute2                               | When installed | With systemd and journald | journald or Docker | Available sections are captured                  |
| Alpine Linux                   | Yes      | Unavailable with OpenRC | With iproute2; no systemd owner correlation | When installed | Unavailable with OpenRC   | Docker only        | Host, filesystem, port, and Docker sections only |

RHEL and SLES use the same inspection commands as Rocky or AlmaLinux and openSUSE Leap respectively, but they are not listed as validated targets until the live SSH suite passes on the actual vendor distributions.

The distribution image checks cover `/etc/os-release`, host facts, uptime, and the account shell. Containers do not prove systemd, journald, boot diagnostics, firewall D-Bus access, or SSH behavior. Those need a booted VM or physical host.

The portable views require ordinary POSIX shell tools. Systemd, Boot, and journald Logs require systemd and journald. Ports requires `ss` from iproute2. Enhanced History requires Bash. Docker inspection requires an accessible Docker daemon.

## Firewall inspection

Ports reads UFW or firewalld when either front-end is installed. UFW rules include its incoming default policy. The firewalld read reports active zones and explicit numeric port rules. Service-name rules, rich rules, direct rules, nftables-only configurations, and iptables-only configurations remain unavailable, so Control Room does not turn a missing numeric rule into a claim that a port is blocked.

On Windows, Ports reports firewall profile enablement and default inbound policies. It does not evaluate individual Windows firewall rules or decide whether a listener is reachable.
