---
title: Docker
description: List Docker containers, group validated Compose labels, and inspect one container.
---

The Docker view reads a bounded `docker ps -a --no-trunc` list. It keeps each container instance distinct and can show a grouped view or a flat view.

## Groups and search

Grouped view uses only validated Compose project and service labels. Containers with missing or invalid Compose identity stay under **Ungrouped**. The fallback is intentional, because a guessed project name is worse than an ungrouped container.

Search matches projects, services, container names, images, and full IDs. A container's row shows its state, status, image, published ports, and validated Compose facts when available.

## Inspect one container

Select one container to load its detail record by the full stable Docker ID. The inspector can show:

- name, image reference, and content ID
- running, paused, restarting, OOM-killed, and dead state
- exit code and lifecycle timestamps
- health status and failing streak
- restart policy and maximum retries
- published ports and network addresses
- mount destinations
- validated Compose project, service, number, and one-off facts

The inspector does not read environment values, command arguments, arbitrary labels, health logs, or host mount sources. It does not offer container lifecycle controls.

## Access and logs

If the Docker daemon is reachable only with sudo, Overview identifies that state and the Docker view can offer a read-only retry. Select a container's logs to open an independent Docker Log Stream. See [Logs](/control-room/inspection/logs/) for stream behavior.
