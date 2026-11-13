#!/usr/bin/env bash
# Install as ~/e2e-linux.sh on the lab VM. One run per VM at a time.
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
branch=${1:?usage: e2e-linux.sh branch [e2e/spec.ts | --installers]}
cd "$HOME/src/control-room"
exec 9>"$HOME/.control-room-e2e.lock"
flock -n 9 || { echo 'A Linux E2E run is already active' >&2; exit 1; }

# Keep the VM disk from filling up. Stale fixtures and bundles always go; build
# caches go only when they have grown past their budget or space is short.
free_gb() { df -Pk "$HOME" | awk 'NR==2 { print int($4 / 1048576) }'; }
prune() {
  # Fixtures younger than 12 hours may still be needed to diagnose a failure.
  find /tmp -maxdepth 1 \( -name 'control-room-*' -o -name 'appimage_extracted_*' \) \
    -mmin +720 -exec rm -rf {} + 2>/dev/null || true
  rm -rf test-results src-tauri/target/debug/bundle
  sudo -n apt-get clean 2>/dev/null || true
  local debug_gb
  debug_gb=$(du -sk src-tauri/target/debug 2>/dev/null | awk '{ print int($1 / 1048576) }')
  # Every branch switch leaves unused artifacts behind in the debug cache.
  if ((${debug_gb:-0} >= 15)); then
    echo "Removing ${debug_gb} GB of accumulated debug build cache"
    rm -rf src-tauri/target/debug
  fi
  if (($(free_gb) < 10)); then rm -rf src-tauri/target/release; fi
  if (($(free_gb) < 10)); then rm -rf src-tauri/target; fi
  if (($(free_gb) < 5)); then
    echo "Only $(free_gb) GB free after removing every build cache; free disk space on the VM" >&2
    exit 1
  fi
  echo "Disk: $(free_gb) GB free"
}

git fetch --force origin "$branch"
git checkout --force --detach FETCH_HEAD
git clean -fdq -e node_modules -e src-tauri/target
echo "Testing $branch at $(git rev-parse HEAD)"
prune
npm ci --no-audit --no-fund
if [[ ${2:-} == --installers ]]; then
  # Release .deb and AppImage: install, reinstall, launch and signed update.
  # The lab VM is disposable, so a build no package reproduces may be replaced.
  CONTROL_ROOM_REPLACE_INSTALLED=1 bash scripts/test-linux-installers.sh
  exit
fi
npm run test:desktop:build
args=()
if [[ -n ${2:-} ]]; then args=(--spec "$2"); fi
bash scripts/test-linux-wdio.sh "${args[@]}"
