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

## Administrator terminals

The shell picker has a separate **Run as administrator** group for PowerShell 7, Windows PowerShell, and Command Prompt. Choosing one opens the Windows UAC prompt, then runs the elevated shell inside Control Room.

Administrator terminals need a one-time Windows setup:

1. Press `Windows + I` to open Windows Settings.
2. Select **System**, then **Advanced**.
3. Turn on **Enable sudo**.
4. Choose **Inline**.
5. Return to Control Room and reopen the **Local terminal** menu.

This setting is available on Windows 11 version 24H2 or later. "Inline" means the administrator shell stays inside the current Control Room terminal instead of opening another window. Windows still shows the UAC confirmation each time you start one. Control Room reads this setting but never changes it.

Inline mode lets the unelevated terminal app send input to the elevated shell. Enable it only when you trust Control Room and the software running on your account. See [Security](/control-room/reference/security/#administrator-local-terminals) for the boundary.

Git Bash has no administrator profile.

## Local session rules

Local shells start with your normal Windows environment and in your user profile directory. The frontend sends only the validated profile id. Rust resolves the executable, fixed arguments, and working directory.

For an administrator profile, Rust also resolves `sudo.exe` from the Windows system directory and passes it only the selected, validated shell. The frontend cannot supply a program or command line.

Local Workspaces:

- have a terminal and nothing else
- can be split with remote terminals
- use the same font, colors, scrollback, and tabs as SSH sessions
- do not run Linux inspection commands through Control Room
- do not record Enhanced History
- do not start automatically after an app restart

If a shell disappears after discovery, Control Room reports it as unavailable instead of starting an unknown executable.
