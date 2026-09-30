---
title: Requirements
description: What you need on Windows and on the SSH host.
---

Control Room runs on Windows 11 x64 and uses the Windows OpenSSH Client. Local terminals use installed PowerShell 7, Windows PowerShell, Command Prompt, or Git Bash.

For an SSH terminal, you need a Linux host that accepts your SSH login. Each inspection view needs its own tools: systemd for services and boot information, journald for service logs, `ss` for ports, and Docker for containers and their logs. Bash is needed only for optional command history. A host can support some views even when others are unavailable.

The terminal can use normal OpenSSH password prompts. Inspection reads run separately and cannot ask for an SSH password. Use a key or an SSH agent for those reads. A key path in Control Room points to your existing file; the app does not copy it.

Docker inspection also needs an account that can read the Docker daemon. If access requires sudo, you can allow a read-only retry.

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
