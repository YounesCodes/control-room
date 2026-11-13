#!/usr/bin/env bash
# Build the release .deb and AppImage and exercise them on a private X11 display:
# installed-package smoke test, clean uninstall/reinstall, AppImage launch, and
# the signed AppImage updater. Needs native Linux support (PR #227) and
# passwordless sudo for apt. The package installed before the run is restored;
# without one, the candidate stays installed.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
export GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1
if [[ ${CONTROL_ROOM_E2E_X11_READY:-0} != 1 ]]; then
  exec xvfb-run -a -s '-screen 0 1440x900x24 -nolisten tcp' dbus-run-session -- env CONTROL_ROOM_E2E_X11_READY=1 bash "$0" "$@"
fi
cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')
binary_hash() { sha256sum "$1" | cut -d' ' -f1; }
packaged_hash() {
  local folder
  folder=$(mktemp -d)
  dpkg-deb -x "$1" "$folder"
  binary_hash "$folder/usr/bin/control-room"
  rm -r "$folder"
}
work=$(mktemp -d /tmp/control-room-linux-installers-XXXXXX)
trap 'rm -rf "$work"' EXIT

# Keep a package that reproduces the current installation before building over it.
restore=
if [[ -x /usr/bin/control-room ]]; then
  installed=$(binary_hash /usr/bin/control-room)
  shopt -s nullglob
  for package in ${CONTROL_ROOM_RESTORE_DEB:+"$CONTROL_ROOM_RESTORE_DEB"} \
    src-tauri/target/release/bundle/deb/*.deb "$HOME"/artifacts/*/*.deb; do
    if [[ $(packaged_hash "$package") == "$installed" ]]; then
      cp "$package" "$work/original.deb"
      restore=$work/original.deb
      break
    fi
  done
  shopt -u nullglob
  # A disposable lab VM may hold a build no package reproduces. Replace it only on request.
  [[ -n $restore || ${CONTROL_ROOM_REPLACE_INSTALLED:-0} == 1 ]] || {
    echo 'No package matches the installed Control Room; set CONTROL_ROOM_RESTORE_DEB or CONTROL_ROOM_REPLACE_INSTALLED=1' >&2
    exit 1
  }
fi

npm run tauri -- build --bundles deb,appimage
deb=(src-tauri/target/release/bundle/deb/*_"$version"_amd64.deb)
appimage=(src-tauri/target/release/bundle/appimage/*_"$version"_amd64.AppImage)
[[ -f ${deb[0]} && -f ${appimage[0]} ]] || { echo 'Release bundles are missing' >&2; exit 1; }
cp "${deb[0]}" "$work/candidate.deb"
if [[ -z $restore ]]; then
  sudo -n apt-get install -y --reinstall "$work/candidate.deb"
  restore=$work/candidate.deb
fi

openbox > "$work/openbox.log" 2>&1 &
wm=$!
trap 'kill "$wm" 2>/dev/null || true; rm -rf "$work"' EXIT
for _ in {1..100}; do
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id # 0x'; then break; fi
  sleep 0.1
done

echo '== Clean .deb install, uninstall and reinstall'
node scripts/test-linux-install-clean.mjs --candidate "$work/candidate.deb" --restore "$restore" --version "$version"

echo '== Release AppImage launch'
node scripts/test-linux-appimage-launch.mjs "${appimage[0]}" "$version"

echo '== Signed AppImage updater'
node scripts/test-updater-lifecycle.mjs

echo '== Installed .deb window, terminal and clipboard smoke test'
# The smoke test starts its own window manager.
kill "$wm"
wait "$wm" 2>/dev/null || true
sudo -n apt-get install -y --reinstall "$work/candidate.deb"
status=0
node scripts/test-linux-desktop.mjs || status=$?
sudo -n apt-get install -y --reinstall "$restore"
[[ $(binary_hash /usr/bin/control-room) == $(packaged_hash "$restore") ]]
[[ $status == 0 ]] || exit "$status"
echo 'Linux installer checks passed'
