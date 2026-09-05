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
- several terminal panes in one Workspace
- focus mode for a larger terminal area

Remote sessions use normal OpenSSH prompts. Structured views use separate, bounded noninteractive operations and do not reuse the terminal's output.

## Split a Workspace

Use the split menu to create a side-by-side or top-and-bottom pane. The menu lists terminals that are already open, plus local shells and Saved Connections you can open into the new pane.

Use the tab or pane controls to select a terminal, close it, or restart it. Closing an active Workspace asks for confirmation before it ends a running session.

## Reconnect and restart

When a remote session ends, the terminal toolbar offers **Reconnect**; when a local shell exits, it offers **Restart**. The `Ctrl+Shift+R` shortcut does the same for the active Workspace. Either action starts a fresh session for the current Workspace. Control Room does not retry on a timer or reconnect after restart without your action.

## Right-click behavior

Right-click is built in rather than a setting. With text selected, a right-click copies the selection. With no selection at an ordinary prompt, it pastes the clipboard. While a program such as Vim, `top`, or tmux is reading the mouse, that program receives the click instead. A right-click inside the terminal never opens the WebView context menu.

`Ctrl+Shift+C` copies the current selection and `Ctrl+Shift+V` pastes.
