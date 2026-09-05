---
title: Terminal
description: Use the integrated SSH terminal, tabs, splits, and session controls.
---

The terminal is an interactive shell backed by the Windows OpenSSH client and ConPTY. Type commands into it as you would in any other SSH client.

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

Use the split menu to create a side-by-side or top-and-bottom pane. A split can contain another terminal for the same Workspace target, a different Saved Connection, or an installed local shell.

Use the tab or pane controls to select a terminal, close it, or restart it. Closing an active Workspace asks for confirmation before it ends a running session.

## Reconnect

Use **Reconnect** from the terminal controls or the `Ctrl+Shift+R` shortcut. Reconnect creates a new remote session for the current Workspace. Control Room does not retry on a timer or reconnect after restart without your action.

## Click behavior

Right-click paste is configurable in Settings. When a remote program such as Vim or `top` enables mouse reporting, the program receives the click instead of the paste action.
