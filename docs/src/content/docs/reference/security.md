---
title: Security and storage
description: What Control Room can change on a host, and what it saves on your computer.
---

Control Room uses the OpenSSH client on your computer. Commands you type in a terminal run with your SSH account's permissions, like in any SSH client.

## Host views only read

Systemd, Ports, Docker, and Logs only read from the host. They never edit files, change firewall rules, or start or stop services and containers.

Three features do change things on the host:

- **Files** uploads files with your SSH account's permissions, and can replace a file that already exists after you confirm.
- **Open terminal** in Docker opens a shell inside a container. Commands you type there can change the container.
- **History** adds a small block to your shell startup file on the host. See [Command history](/control-room/tools/history/).

## Sudo

Sudo is off by default. In Settings, you can let the host views use sudo on one host or on all hosts. They use it only when the account can run sudo without a password. Otherwise they show what they can read and say what is missing.

Some views offer a one-time **Retry with sudo** that asks for your sudo password. Control Room uses the password for that one read, then forgets it. It never saves the password or puts it in a command line.

If a container terminal needs sudo to reach Docker, sudo asks for your password inside that terminal. Control Room never sees it.

## Administrator terminals

Administrator terminals on Windows use Windows sudo in **Inline** mode, and Windows asks you to confirm each one. Inline mode lets Control Room type into the administrator shell. Commands there can change your Windows computer, so turn it on only if you trust the programs running under your account.

## Stored locally

Control Room keeps one database file on your computer. It holds your connections, groups and tags, settings, tab layout, Scratchpad notes, saved details about each host, and command history if you turned it on.

| Computer | Database file                                                           |
| -------- | ----------------------------------------------------------------------- |
| Windows  | `%APPDATA%\app.controlroom.desktop\control-room.db`                     |
| Linux    | `~/.local/share/app.controlroom.desktop/control-room.db`                |
| macOS    | `~/Library/Application Support/app.controlroom.desktop/control-room.db` |

The database is not encrypted. Don't put passwords or keys in notes, and keep in mind that saved commands can contain them.

## Never stored

Control Room never saves SSH or sudo passwords, the contents of your private keys, terminal output, or logs. It can save the path to a key, but the key stays where it is.
