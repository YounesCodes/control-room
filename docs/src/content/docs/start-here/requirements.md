---
title: Requirements
description: What you need on Windows and on the SSH host.
---

Control Room runs on Windows 11 x64 and uses the Windows OpenSSH Client. Local terminals use installed PowerShell 7, Windows PowerShell, Command Prompt, or Git Bash.

For an SSH terminal, you need a Linux host that accepts your SSH login. Each inspection view needs its own tools: systemd for services and boot information, journald for service logs, `ss` for ports, and Docker for containers and their logs. Bash is needed only for optional command history. A host can support some views even when others are unavailable.

The terminal can use normal OpenSSH password prompts. Inspection reads run separately and cannot ask for an SSH password. Use a key or an SSH agent for those reads. A key path in Control Room points to your existing file; the app does not copy it.

Docker inspection also needs an account that can read the Docker daemon. If access requires sudo, you can allow a read-only retry.
