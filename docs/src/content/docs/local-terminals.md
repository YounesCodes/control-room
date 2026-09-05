---
title: Local terminals
description: Run installed Windows shells inside Control Room.
---

Control Room can host local Windows shells in terminal-only Local Workspaces. Select **Local terminal** in the lower-left rail and choose an installed profile.

## Supported profiles

| Profile            | Executable                      |
| ------------------ | ------------------------------- |
| PowerShell 7       | `pwsh.exe`                      |
| Windows PowerShell | `powershell.exe`                |
| Command Prompt     | `cmd.exe`                       |
| Git Bash           | `bash.exe` from Git for Windows |

Only profiles that are installed are offered. PowerShell 7 and Git for Windows use deterministic checks of standard install locations plus the allowed PATH lookup. Git Bash never uses `System32\bash.exe`, which is the WSL launcher.

## Local session rules

Local shells start with your normal Windows environment and in your user profile directory. The frontend sends only the validated profile id. Rust resolves the executable, fixed arguments, and working directory.

Local Workspaces:

- have a terminal and nothing else
- can be split with remote terminals
- use the same font, colors, scrollback, and tabs as SSH sessions
- do not run Linux inspection commands through Control Room
- do not record Enhanced History
- do not start automatically after an app restart

If a shell disappears after discovery, Control Room reports it as unavailable instead of starting an unknown executable.
