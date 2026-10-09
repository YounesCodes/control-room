---
title: Local terminals
description: Open PowerShell, Command Prompt, or Git Bash in the app.
---

Select **Local terminal** in the sidebar. With one enabled shell, it starts directly. With several enabled, choose one from the menu. Local tabs use the same terminal settings and splits as SSH tabs, but have no Linux inspection views.

Control Room offers installed PowerShell 7, Windows PowerShell, Command Prompt, and Git Bash from Git for Windows. You can hide a shell from the menus in [Settings](/control-room/reference/settings/#local-terminal); a shell already running stays open.

In Git Bash, OpenCode and other OpenTUI apps use the main terminal screen by default. This avoids a Windows console issue that can break terminal input when they quit. Control Room sets `OTUI_USE_ALTERNATE_SCREEN=0` for new Git Bash sessions unless you already set that variable in your Windows environment. Other terminal apps keep their usual screen behavior.

Enable **Local Terminal Mode** in [Settings](/control-room/reference/settings/#local-terminal) to start your default local terminal in Focus Mode when Control Room opens. Startup uses an enabled standard shell without administrator elevation. The Connections sidebar is hidden in Focus Mode. Exit focus to show it again.

## Administrator shells

**Run as administrator** is available for PowerShell 7, Windows PowerShell, and Command Prompt. Windows asks for UAC confirmation each time.

Administrator terminals need a one-time Windows setup:

1. Press `Windows + I` to open Windows Settings.
2. Select **System**, then **Advanced**.
3. Turn on **Enable sudo**.
4. Choose **Inline**.
5. Return to Control Room and reopen the **Local terminal** menu.

Windows 11 version 24H2 or later provides this setting. **Inline** keeps the administrator shell inside Control Room. It also lets the app send input to that elevated shell, so enable it only when you trust the app and programs running under your account. [Security](/control-room/reference/security/#administrator-local-terminals) explains this access.

The setup warning appears only when an enabled shell supports administrator mode and needs that setup. Git Bash alone does not trigger it.

Git Bash has no administrator option. Local shells do not record Enhanced History. After an app restart, restored local tabs start fresh shells.
