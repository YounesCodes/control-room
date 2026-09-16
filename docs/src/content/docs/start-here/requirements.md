---
title: Requirements
description: Supported Windows, SSH, Linux, systemd, journald, and Docker environments.
---

## Local machine

| Area             | Support                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| Operating system | Windows 11 x64                                                           |
| SSH client       | The Windows OpenSSH Client installed on the machine                      |
| Terminal         | Windows ConPTY through the app                                           |
| Local shells     | Installed PowerShell 7, Windows PowerShell, Command Prompt, and Git Bash |

Control Room does not launch or embed Windows Terminal. Git Bash means the `bash.exe` shipped with Git for Windows, not the `System32\bash.exe` WSL launcher.

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

The distribution image checks cover `/etc/os-release`, host facts, uptime, the account shell, `/proc`, and filesystem output. Containers do not prove systemd, journald, boot diagnostics, firewall D-Bus access, or SSH behavior. Those need a booted VM or physical host.

The portable views require ordinary POSIX shell tools. Systemd, Boot, and journald Logs require systemd and journald. Ports requires `ss` from iproute2. Enhanced History requires Bash. Docker inspection requires an accessible Docker daemon.

## Authentication

Interactive SSH uses normal OpenSSH behavior, including its prompts. Structured operations use noninteractive SSH and therefore need public-key authentication or an SSH agent identity that connects without prompting for an SSH password.

An identity-file field points to a key where it already exists. Control Room does not copy or import the key.

## Docker access

Docker inspection works when the connected account can query the Docker daemon. If it needs sudo, you can enable the read-only sudo allowance and retry the operation. Sudo does not let a structured operation change the host.

## Firewall inspection

Ports reads UFW or firewalld when either front-end is installed. UFW rules include its incoming default policy. The firewalld read reports active zones and explicit numeric port rules. Service-name rules, rich rules, direct rules, nftables-only configurations, and iptables-only configurations remain unavailable, so Control Room does not turn a missing numeric rule into a claim that a port is blocked.

## Known boundaries

Control Room does not inspect Windows services, processes, ports, Docker, or Event Log. It does not scan hosts, test reachability, manage remote services or containers, install packages, or collect a remote environment dump.
