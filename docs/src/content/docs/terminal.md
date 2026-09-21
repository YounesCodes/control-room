---
title: Terminal
description: Use the integrated SSH terminal, tabs, splits, and session controls.
---

The terminal is an interactive shell that runs through the Windows OpenSSH client and ConPTY. Type commands into it as you would in any other SSH client.

## New terminal

**New terminal** in the tab strip opens a target chooser listing every Saved Connection and every installed local shell. Choosing one creates an independent Workspace for that target, so choosing the target you are already using opens a second terminal for it instead of reusing the one on screen.

## Session behavior

Each Terminal Session belongs to one Workspace. It has its own reader, writer, resize path, flow control, and lifecycle. A dropped remote session can be reconnected. A local shell that exits is stopped and can be started again.

The terminal supports:

- Unicode, ANSI, and VT output
- copy and paste
- terminal resizing
- configurable font, colors, and scrollback
- named groups of terminal panes in focus mode
- focus mode for a larger terminal area

Remote sessions use normal OpenSSH prompts. Structured views use separate, bounded noninteractive operations and do not reuse the terminal's output.

## Focus groups and splits

Enter focus mode from a Terminal view to work without the connection rail and host tools. A single terminal remains an ordinary tab. A group appears only after you split that terminal with another one, and it can contain terminals from different Saved Connections and local shells. Use the group tabs to switch between layouts such as a Proxmox group and a cloud cluster group.

Use the split menu in focus mode to create a side-by-side or top-and-bottom pane. The menu lists ungrouped terminals that are already open, plus local shells and Saved Connections. Use **New terminal** to open another ungrouped tab. Deleting a group leaves each of its terminals open as an ordinary tab.

Exit focus mode to return to the active Workspace. Its Overview, Systemd, Ports, Docker, and other host views remain available there.

Use the tab or pane controls to select a terminal, close it, or restart it. Closing an active Workspace asks for confirmation before it ends a running session.

## Reconnect and restart

When a remote session ends, the terminal toolbar offers **Reconnect**; when a local shell exits, it offers **Restart**. The `Ctrl+Shift+R` shortcut does the same for the active Workspace. Either action starts a fresh session for the current Workspace. Control Room does not retry on a timer or reconnect after restart without your action.

## Right-click behavior

Right-click is built in rather than a setting. With text selected, a right-click copies the selection. With no selection at an ordinary prompt, it pastes the clipboard. While a program such as Vim, `top`, or tmux is reading the mouse, that program receives the click instead. A right-click inside the terminal never opens the WebView context menu.

`Ctrl+Shift+C` copies the current selection and `Ctrl+Shift+V` pastes.
