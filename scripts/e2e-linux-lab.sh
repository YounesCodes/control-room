#!/usr/bin/env bash
# Install as ~/e2e-linux.sh on the lab VM. One run per VM at a time.
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
branch=${1:?usage: e2e-linux.sh branch [e2e/spec.ts | --installers]}
cd "$HOME/src/control-room"
exec 9>"$HOME/.control-room-e2e.lock"
flock -n 9 || { echo 'A Linux E2E run is already active' >&2; exit 1; }
git fetch --force origin "$branch"
git checkout --force --detach FETCH_HEAD
git clean -fdq -e node_modules -e src-tauri/target
echo "Testing $branch at $(git rev-parse HEAD)"
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
