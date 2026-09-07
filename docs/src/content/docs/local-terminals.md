---
title: Local terminals
description: Run supported Windows and macOS shells inside Control Room.
---

Control Room can host local shells in terminal-only Local Workspaces. Select **Local terminal** in the lower-left rail and choose an installed profile.

## Supported profiles

| Client  | Profile            | Executable or source                  |
| ------- | ------------------ | ------------------------------------- |
| Windows | PowerShell 7       | `pwsh.exe`                            |
| Windows | Windows PowerShell | `powershell.exe`                      |
| Windows | Command Prompt     | `cmd.exe`                             |
| Windows | Git Bash           | `bash.exe` from Git for Windows       |
| macOS   | zsh                | `/bin/zsh`, `/usr/bin/zsh`, or PATH   |
| macOS   | Bash               | `/bin/bash`, `/usr/bin/bash`, or PATH |
| macOS   | fish               | Homebrew locations or PATH            |

Only profiles that are installed are offered. Windows uses deterministic checks of standard install locations plus the allowed PATH lookup for PowerShell 7 and Git for Windows. Git Bash never uses `System32\bash.exe`, which is the WSL launcher. macOS prefers fixed system or Homebrew paths before PATH.

## Local session rules

Local shells start with your normal client environment and in your home directory. The frontend sends only the validated profile id. Rust resolves the executable, fixed arguments, and working directory. It starts zsh and fish as login shells, and Bash as an interactive login shell.

Local Workspaces:

- have a terminal and nothing else
- can be split with remote terminals
- use the same font, colors, scrollback, and tabs as SSH sessions
- do not run Linux inspection commands through Control Room
- do not record Enhanced History
- do not start automatically after an app restart

If a shell disappears after discovery, Control Room reports it as unavailable instead of starting an unknown executable.
