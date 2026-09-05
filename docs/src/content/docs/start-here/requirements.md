---
title: Requirements and support
description: Supported Windows, SSH, Linux, systemd, journald, and Docker environments.
---

## Local machine

| Area | Support |
| --- | --- |
| Operating system | Windows 11 x64 |
| SSH client | The Windows OpenSSH Client installed on the machine |
| Terminal | Windows ConPTY through the app |
| Local shells | Installed PowerShell 7, Windows PowerShell, Command Prompt, and Git Bash |

Control Room does not launch or embed Windows Terminal. Git Bash means the `bash.exe` shipped with Git for Windows, not the `System32\bash.exe` WSL launcher.

## Structured remote inspection

The structured views target Debian and Ubuntu family hosts with:

- systemd for service and boot inspection
- journald for logs and boot journal samples
- Bash for Enhanced History
- `ss` from iproute2 for listener and connection snapshots
- Docker when Docker inspection is installed and accessible

Other Linux systems can still work as terminal-only hosts. Their structured views are best effort and may be unavailable.

## Authentication

Interactive SSH uses normal OpenSSH behavior, including its prompts. Structured operations use noninteractive SSH and therefore need public-key authentication or an SSH agent identity that connects without prompting for an SSH password.

An identity-file field points to a key where it already exists. Control Room does not copy or import the key.

## Docker access

Docker inspection works when the connected account can query the Docker daemon. If it needs sudo, you can enable the read-only sudo allowance and retry the operation. Sudo does not let a structured operation change the host.

## Known boundaries

Control Room does not inspect Windows services, processes, ports, Docker, or Event Log. It does not scan hosts, test reachability, manage remote services or containers, install packages, or collect a remote environment dump.
