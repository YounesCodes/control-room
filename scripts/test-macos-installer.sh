#!/bin/bash
# Build the release .app and DMG, install the app from the DMG into a private
# folder, launch it on the logged-in desktop and check its window and database.
# Needs native macOS support (PR #65) and a disposable account: the release app
# uses the account's real data folder, which must not exist beforehand.
# Production WKWebViews cannot be driven without Accessibility approval, so this
# does not click through the UI.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')
data="$HOME/Library/Application Support/app.controlroom.desktop"
if [[ -e $data ]]; then
  [[ -f $data/.installer-fixture ]] || {
    echo "Refusing to use existing user data: $data" >&2
    exit 1
  }
  rm -rf "$data"
fi
work=$(mktemp -d /tmp/control-room-macos-installer-XXXXXX)
pid=
cleanup() {
  [[ -z $pid ]] || kill "$pid" 2>/dev/null || true
  hdiutil detach "$work/dmg" -quiet 2>/dev/null || true
  [[ ! -f $data/.installer-fixture ]] || rm -rf "$data"
  rm -rf "$work"
}
trap cleanup EXIT

# CI=true keeps the DMG step from scripting Finder, which needs Automation approval.
CI=true npm run tauri -- build --bundles app,dmg
bundle=src-tauri/target/release/bundle
dmg=$(find "$bundle/dmg" -maxdepth 1 -name "*_${version}_*.dmg" -print -quit)
[[ -n $dmg ]] || { echo 'The release DMG is missing' >&2; exit 1; }
hdiutil verify -quiet "$dmg"
mkdir "$work/dmg" "$work/Applications"
hdiutil attach "$dmg" -nobrowse -readonly -quiet -mountpoint "$work/dmg"
ditto "$work/dmg/Control Room.app" "$work/Applications/Control Room.app"
hdiutil detach "$work/dmg" -quiet
app="$work/Applications/Control Room.app"
[[ $(defaults read "$app/Contents/Info" CFBundleShortVersionString) == "$version" ]]
[[ $(defaults read "$app/Contents/Info" CFBundleIdentifier) == app.controlroom.desktop ]]
codesign --verify --deep --strict "$app"

mkdir -p "$data"
touch "$data/.installer-fixture"
"$app/Contents/MacOS/control-room" > "$work/app.log" 2>&1 &
pid=$!
windows() {
  /usr/bin/swift -e "import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
print(list.filter { (\$0[kCGWindowOwnerPID as String] as? Int) == $pid && (\$0[kCGWindowLayer as String] as? Int) == 0 }.count)"
}
shown=0
for _ in {1..30}; do
  kill -0 "$pid" 2>/dev/null || { cat "$work/app.log" >&2; echo 'The installed app exited during startup' >&2; exit 1; }
  if [[ -f $data/control-room.db && $(windows) -ge 1 ]]; then shown=1; break; fi
  sleep 2
done
[[ $shown == 1 ]] || { cat "$work/app.log" >&2; echo 'The installed app showed no window or database' >&2; exit 1; }
[[ $(sqlite3 "file:$data/control-room.db?mode=ro" 'PRAGMA integrity_check') == ok ]]
schema=$(sqlite3 "file:$data/control-room.db?mode=ro" 'PRAGMA user_version')
kill "$pid"
for _ in {1..40}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$pid" 2>/dev/null; then echo 'The installed app did not quit' >&2; exit 1; fi
pid=
echo "macOS $version DMG installed, opened a window, created schema $schema and quit cleanly"
