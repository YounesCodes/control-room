#!/usr/bin/env bash
# Run the full native suite on a private X11 display with a real window manager.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
export TAURI_WEBVIEW_AUTOMATION=true
export GDK_BACKEND=x11
if [[ ${CONTROL_ROOM_E2E_X11_READY:-0} != 1 ]]; then
  exec xvfb-run -a -s '-screen 0 1920x1080x24' dbus-run-session -- env CONTROL_ROOM_E2E_X11_READY=1 bash "$0" "$@"
fi
openbox > /tmp/control-room-openbox-$$.log 2>&1 &
wm_pid=$!
trap 'kill "$wm_pid" 2>/dev/null || true; rm -f /tmp/control-room-openbox-$$.log' EXIT
# Openbox must advertise the WM before maximize/restore tests start.
for attempt in {1..100}; do
  if xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id # 0x'; then break; fi
  sleep 0.1
done
xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id # 0x'
npm run test:desktop -- "$@"
