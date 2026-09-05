---
title: Control Room
description: A Windows SSH client with read-only Linux host inspection.
template: splash
hero:
  title: Work beside the machine
  tagline: An integrated Windows terminal for SSH sessions, with bounded read-only views of the Linux host you are already connected to.
  image:
    file: ../../assets/app-icon.svg
    alt: Control Room app icon
  actions:
    - text: Start here
      link: /control-room/start-here/introduction/
      icon: right-arrow
    - text: View on GitHub
      link: https://github.com/YounesCodes/control-room
      icon: external
      variant: minimal
---

Control Room keeps the interactive shell. It adds host context around the same Saved Connection: services, ports, Docker, boot evidence, logs, baselines, and optional Bash command history.

It runs locally on Windows. Remote inspection stays read-only. When you need to change a machine, use the terminal with the permissions of the connected account.

## Find your way around

| If you want to... | Start with... |
| --- | --- |
| Install the app and connect to a host | [Installation](/control-room/start-here/installation/) and [Quick start](/control-room/start-here/quick-start/) |
| Understand what is supported | [Requirements and support](/control-room/start-here/requirements/) |
| Open a local shell or split terminals | [Local terminals](/control-room/local-terminals/) and [Workspaces](/control-room/workspaces/) |
| Inspect a Linux host | [Host overview](/control-room/inspection/overview/) |
| Understand permissions and stored data | [Security and data](/control-room/reference/security/) |
| Build the app or improve the docs | [Development setup](/control-room/development/setup/) |

## The boundary

Control Room does not copy files, edit remote files, manage services or containers, run a monitoring agent, store private keys, or open an external terminal window. Structured views query the connected Remote Host with bounded commands and keep fetched output in memory unless a feature says otherwise.
