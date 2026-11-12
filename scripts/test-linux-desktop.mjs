// Run on the hosted Ubuntu X11 desktop after installing the .deb.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const home = mkdtempSync(join(tmpdir(), "control-room-desktop-"));
const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: join(home, "data"),
  SHELL: "/bin/bash",
  TAURI_WEBVIEW_AUTOMATION: "true",
};
const wm = spawn("openbox", [], { env, stdio: "inherit" });
const driver = spawn("WebKitWebDriver", ["--port=4444"], { env, stdio: "inherit" });
const driverUrl = "http://127.0.0.1:4444";
let session;

function windowId() {
  try {
    return xdo("search", "--onlyvisible", "--name", "^Control Room$").split("\n")[0];
  } catch {
    return null;
  }
}

async function request(method, path, body) {
  const response = await fetch(driverUrl + path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const { value } = await response.json();
  assert.ok(response.ok, value?.message ?? path);
  return value;
}

function execute(script, ...args) {
  return request("POST", "/session/" + session + "/execute/sync", { script, args });
}

async function waitFor(label, condition) {
  const deadline = Date.now() + 15_000;
  do {
    if (await condition()) return;
    await pause(100);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for " + label);
}

async function click(label) {
  const selector = "button[aria-label=" + JSON.stringify(label) + "]";
  await waitFor(label, () =>
    execute(
      "return !!document.querySelector(arguments[0] + ':not([disabled])')?.offsetWidth",
      selector,
    ),
  );
  const element = await request("POST", "/session/" + session + "/element", {
    using: "css selector",
    value: selector,
  });
  await request(
    "POST",
    "/session/" + session + "/element/" + Object.values(element)[0] + "/click",
    {},
  );
}

function xdo(...args) {
  return execFileSync("xdotool", args, { encoding: "utf8", timeout: 5000 }).trim();
}

function terminalText(marker) {
  return waitFor(marker, () =>
    execute(
      "return Array.from(document.querySelectorAll('.terminal-workspace-pane.active .xterm-rows > div'), row => row.textContent).some(line => line.includes(arguments[0]))",
      marker,
    ),
  );
}

try {
  await waitFor("WebKitWebDriver", () => request("GET", "/status").catch(() => false));
  ({ sessionId: session } = await request("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        "webkitgtk:browserOptions": { binary: "/usr/bin/control-room" },
      },
    },
  }));

  await click("New terminal");
  assert.equal(
    await execute(
      "return document.querySelector('[aria-label^=\"Run as administrator:\"]') !== null",
    ),
    false,
  );
  await click("Local terminals: Bash");
  await waitFor("focused terminal", () =>
    execute("return document.activeElement?.classList.contains('xterm-helper-textarea')"),
  );
  execFileSync("xclip", ["-selection", "clipboard"], {
    input: "printf 'LINUX_%s\n' CLIPBOARD",
    stdio: ["pipe", "ignore", "inherit"],
  });
  xdo("key", "--clearmodifiers", "ctrl+shift+v", "Return");
  await terminalText("LINUX_CLIPBOARD");

  await click("Focus terminal");
  await click("New terminal");
  await click("Split right, side by side");
  await click("Local terminals: Bash");
  await waitFor("two visible terminal panes", () =>
    execute(
      "return document.querySelectorAll('.terminal-workspace-pane-visible .xterm').length === 2",
    ),
  );

  const id = windowId();
  assert.ok(id);
  const geometry = () =>
    Object.fromEntries(
      xdo("getwindowgeometry", "--shell", id)
        .split("\n")
        .map((line) => line.split("="))
        .map(([key, value]) => [key, Number(value)]),
    );
  const width = () => geometry().WIDTH;
  const initial = width();
  await click("Maximize or restore window");
  await waitFor("maximized window", () => width() > initial);
  await click("Maximize or restore window");
  await waitFor("restored window", () => width() === initial);

  const height = geometry().HEIGHT;
  xdo(
    "mousemove",
    "--window",
    id,
    String(initial - 2),
    String(Math.floor(height / 2)),
    "mousedown",
    "1",
  );
  await pause(250);
  xdo("mousemove_relative", "--", "70", "0");
  xdo("mouseup", "1");
  await waitFor("window resize by its edge", () => width() > initial);

  await click("Minimize window");
  await waitFor("minimized window", () => !windowId());
  xdo("windowactivate", "--sync", id);
  await waitFor("restored window after minimize", () => windowId() === id);
  await waitFor("active terminal focus", () =>
    execute("return document.activeElement?.classList.contains('xterm-helper-textarea')"),
  );

  xdo("type", "--clearmodifiers", "exit");
  xdo("key", "Return");
  await waitFor("terminal exit", () =>
    execute(
      "return document.querySelector('.terminal-workspace-pane.active .terminal-notice-action')?.textContent.includes('Restart')",
    ),
  );
  mkdirSync("test-results/linux-desktop", { recursive: true });
  const screenshot = await request("GET", "/session/" + session + "/screenshot");
  writeFileSync("test-results/linux-desktop/terminal.png", Buffer.from(screenshot, "base64"));

  await click("Close window").catch((error) => {
    // Closing the only WebView can end the session before the click is acknowledged.
    if (!/window|session|disconnect/i.test(String(error))) throw error;
  });
  await waitFor("closed window", () => !windowId());
  assert.ok(existsSync(join(env.XDG_DATA_HOME, "app.controlroom.desktop", "control-room.db")));
  console.log(
    "Installed .deb opened, pasted into Bash, split, maximized, resized, and closed under X11.",
  );
} finally {
  if (session) await request("DELETE", "/session/" + session).catch(() => {});
  driver.kill();
  wm.kill();
  rmSync(home, { recursive: true, force: true });
}
