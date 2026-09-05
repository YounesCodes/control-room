---
title: Logs
description: Read bounded journald or Docker log streams without storing fetched output.
---

A service is misbehaving and you want its recent output without leaving Control Room. Logs opens
a stream for one systemd unit or one Docker container. Pick a tail of 50, 100, 200, 500, or 1000
lines and follow new lines while you work. Closing the view stops the stream.

## Stream controls

The log view supports:

- starting a stream with the selected tail size
- following new lines
- pausing or resuming rendering
- stopping a stream
- clearing the current view
- searching the lines already loaded

Systemd logs come from `journalctl` for the selected unit. Docker logs come from `docker logs` for the selected container. These are read-only requests.

## Retention

Each Log Stream has its own bounded in-memory buffer. Streams stop when the view unmounts. Control Room does not persist terminal output, fetched journald output, or Docker logs in SQLite.

Logs are not a complete journal browser. Select a unit or container first, then use the terminal for a different query when you need one.
