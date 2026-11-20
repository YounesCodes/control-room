---
title: Local terminals
description: Open shells on your own computer in tabs and splits.
---

A local terminal runs a shell on your own computer instead of on a host. Select **New terminal** and choose a shell under **Local terminals**. Local tabs work like SSH tabs, with splits and search, but they have no host views.

| Computer | Shells offered when installed                                       |
| -------- | ------------------------------------------------------------------- |
| Windows  | PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, and WSL |
| Linux    | Your login shell first, then Bash, zsh, fish, and `sh`              |
| macOS    | zsh, Bash, and fish                                                 |

To hide a shell from the list, use [Settings](/control-room/reference/settings/#local-terminals). To start in a local terminal every time the app opens, turn on **Local Terminal Mode** there.

## WSL

Each installed WSL distribution, such as **WSL: Ubuntu**, gets its own entry. It starts in your Linux home folder. The first one after Windows starts can take a few seconds. If you install a new distribution, for example with `wsl --install`, reopen the **New terminal** menu to see it.

## Git Bash

In Git Bash, Control Room sets `OTUI_USE_ALTERNATE_SCREEN=0`. This stops OpenCode and other OpenTUI apps from breaking the terminal's input when they quit. If you set this variable yourself in Windows, your value is used.

## Administrator terminals on Windows

PowerShell 7, Windows PowerShell, and Command Prompt can run as administrator. Windows asks you to confirm each time. Git Bash and WSL can't.

This needs Windows 11 version 24H2 or newer and a one-time setup:

1. Press `Windows + I` to open Windows Settings.
2. Go to **System > Advanced**.
3. Turn on **Enable sudo** and choose **Inline**.
4. Reopen the **New terminal** menu in Control Room.

**Inline** keeps the administrator shell inside Control Room. It also lets the app type into that shell, so turn it on only if you trust the programs running under your account. See [Security](/control-room/reference/security/#administrator-terminals).
