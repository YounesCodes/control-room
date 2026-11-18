#!/usr/bin/env bash
set -euo pipefail

# Hosted runners list their cloud's regional Ubuntu mirror first (Azure, or an
# EC2 mirror in another region on AWS runners). Those can trickle at a few
# kB/s without erroring, so APT never fails over. Use only the official mirror.
mirrors=/etc/apt/apt-mirrors.txt
if [[ -f "$mirrors" ]]; then
  sudo sed -i -E '\#^https?://[^/]+\.archive\.ubuntu\.com/#d' "$mirrors"
  grep -q '^https://archive\.ubuntu\.com/ubuntu/' "$mirrors"
fi

apt_options=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get "${apt_options[@]}" update
sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get "${apt_options[@]}" install -y --no-install-recommends "$@"
