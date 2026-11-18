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

apt() {
  sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l timeout "$1" apt-get     -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 "${@:2}"
}

# APT keeps finished downloads, so each bounded attempt resumes where the last stopped.
download_attempts=3
for attempt in $(seq "$download_attempts"); do
  if apt 60 update && apt 180 install -y --no-install-recommends --download-only "$@"; then
    break
  fi
  if [[ $attempt == "$download_attempts" ]]; then
    echo "APT downloads did not finish after $download_attempts bounded attempts" >&2
    exit 1
  fi
  echo "APT download attempt $attempt stalled or failed; retrying" >&2
done
apt 300 install -y --no-install-recommends "$@"
