#!/bin/zsh
# Install as ~/Developer/e2e-mac.sh in the Mac lab VM's tester account.
# Usage: e2e-mac.sh <branch> [e2e/spec.ts | --installers]
set -euo pipefail
source ~/.zshenv 2>/dev/null || true
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
branch=${1:?usage: e2e-mac.sh branch [e2e/spec.ts | --installers]}
mode=${2:-}
repo=~/Developer/control-room-e2e
[ -d $repo/.git ] || git clone https://github.com/YounesCodes/control-room.git $repo
cd $repo
# One run at a time: a second run would fight over the desktop and the build.
lock=~/Developer/.control-room-e2e.lock
if ! mkdir $lock 2>/dev/null; then
  if kill -0 "$(cat $lock/pid 2>/dev/null)" 2>/dev/null; then
    echo 'A Mac E2E run is already active' >&2
    exit 1
  fi
fi
echo $$ > $lock/pid
trap 'rm -rf $lock' EXIT

# Keep the small VM disk from filling up. Stale fixtures and bundles always go;
# build caches go only when they have grown past their budget or space is short.
free_gb() { df -Pk "$HOME" | awk 'NR==2 { print int($4 / 1048576) }'; }
prune() {
  # Fixtures younger than 12 hours may still be needed to diagnose a failure.
  find /tmp "${TMPDIR:-/tmp}" -maxdepth 1 -name 'control-room-*' -mmin +720 \
    -exec rm -rf {} + 2>/dev/null || true
  rm -rf test-results src-tauri/target/debug/bundle
  local debug_gb
  debug_gb=$(du -sk src-tauri/target/debug 2>/dev/null | awk '{ print int($1 / 1048576) }')
  # Every branch switch leaves unused artifacts behind in the debug cache.
  if ((${debug_gb:-0} >= 5)); then
    echo "Removing ${debug_gb} GB of accumulated debug build cache"
    rm -rf src-tauri/target/debug
  fi
  if (($(free_gb) < 3)); then rm -rf src-tauri/target/release; fi
  if (($(free_gb) < 3)); then rm -rf src-tauri/target; fi
  if (($(free_gb) < 2)); then
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
if [[ $mode == --installers ]]; then
  # Release .app and DMG: build, install from the DMG, launch and quit.
  # The release cache is rarely reused and the disk is small, so drop it afterwards.
  bash scripts/test-macos-installer.sh && result=0 || result=$?
  rm -rf src-tauri/target/release
  exit $result
fi
npm run test:desktop:build
if [ -n "$mode" ]; then npm run test:desktop -- --spec "$mode"; else npm run test:desktop; fi
