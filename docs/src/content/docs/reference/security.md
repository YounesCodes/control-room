---
title: Security
description: What host reads can do and what the app saves.
---

Control Room uses your Windows OpenSSH client. Commands you type in the terminal run with your SSH account's permissions. The inspection views run separate, limited reads for the information they show.

## Host inspection

The host views read systemd, journald, Docker, ports, filesystems, and boot information. They do not edit files or manage services and containers. Overview sampling stops when you leave the view. An open terminal keeps its SSH session until you close it.

## Elevated reads

Sudo is off by default. You can allow passwordless sudo reads for one host or all hosts. The app uses sudo only when the account can run that read without a password; otherwise it reads what it can and shows the limitation.

Some views offer a one-time retry that asks for a sudo password. Control Room uses that password for the retry and discards it. It does not save the password or add it to a command line. Sudo does not give the inspection views write controls.

## Administrator local terminals

Administrator local shells use Windows Sudo in inline mode and require UAC approval. Inline mode lets Control Room send input to the elevated shell. Commands you type there can change this Windows machine, so use this option only when you trust the app and programs running under your account. This is separate from sudo on an SSH host.

## Stored locally

Control Room saves connections, groups and tags, settings, tab layout, your Scratchpad notes, cached host details, optional Bash command history, and baselines you choose to capture in a local SQLite database.

## Never stored

It does not save SSH or sudo passwords, private key contents, terminal output, fetched logs, boot diagnostics, or update installer bytes. A key path can be saved, but the key stays where it is. Notes and saved command history are local data, not encrypted secret storage.
