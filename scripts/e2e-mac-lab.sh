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
git fetch --force origin "$branch"
git checkout --force --detach FETCH_HEAD
git clean -fdq -e node_modules -e src-tauri/target
echo "Testing $branch at $(git rev-parse HEAD)"
npm ci --no-audit --no-fund
if [[ $mode == --installers ]]; then
  # Release .app and DMG: build, install from the DMG, launch and quit.
  bash scripts/test-macos-installer.sh
  exit
fi
npm run test:desktop:build
if [ -n "$mode" ]; then npm run test:desktop -- --spec "$mode"; else npm run test:desktop; fi
