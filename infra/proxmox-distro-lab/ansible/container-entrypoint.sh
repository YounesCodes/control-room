#!/bin/sh
set -eu

install -m 0600 /run/secrets/control-room-lab-key /tmp/control-room-lab-key
exec ansible-playbook "$@"
