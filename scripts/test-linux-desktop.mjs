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
  // A window mapped while Openbox is still starting can stay unmanaged and
  // invisible to the window lookup. Start the app only under a ready WM.
  await waitFor("window manager", () => {
    try {
      xdo("get_num_desktops");
      return true;
    } catch {
      return false;
    }
  });
  await waitFor("WebKitWebDriver", () => request("GET", "/status").catch(() => false));
  ({ sessionId: session } = await request("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        "webkitgtk:browserOptions": { binary: "/usr/bin/control-room" },
      },
    },
  }));

  await waitFor("Linux desktop capabilities", () =>
    execute("return !!document.querySelector('.window-resize-handle')"),
  );
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
  // The window manager can map and title the window after the webview is ready.
  let id;
  await waitFor("native window", () => (id = windowId()));
  // Activation can be refused while the window manager is still settling.
  await waitFor("active native window", () => {
    try {
      xdo("windowactivate", id);
      return xdo("getactivewindow") === id;
    } catch {
      return false;
    }
  });
  execFileSync("xclip", ["-selection", "clipboard"], {
    input: "printf 'LINUX_%s\n' CLIPBOARD",
    stdio: ["pipe", "ignore", "inherit"],
  });
  xdo("key", "--clearmodifiers", "ctrl+shift+v");
  await terminalText("CLIPBOARD");
  xdo("key", "Return");
  await terminalText("LINUX_CLIPBOARD");

  const geometry = () =>
    Object.fromEntries(
      xdo("getwindowgeometry", "--shell", id)
        .split("\n")
        .map((line) => line.split("="))
        .map(([key, value]) => [key, Number(value)]),
    );
  const width = () => geometry().WIDTH;
  const outputPoint = await execute(
    "const row = Array.from(document.querySelectorAll('.terminal-workspace-pane.active .xterm-rows > div')).find(el => el.textContent.includes('LINUX_CLIPBOARD')); const box = row.getBoundingClientRect(); return [Math.round(box.x + 6), Math.round(box.y + box.height / 2)];",
  );
  xdo("mousemove", "--window", id, ...outputPoint.map(String), "click", "--repeat", "2", "1");
  xdo("key", "--clearmodifiers", "ctrl+shift+c");
  await waitFor("terminal selection copied to clipboard", () =>
    execFileSync("xclip", ["-selection", "clipboard", "-o"], {
      encoding: "utf8",
      timeout: 5000,
    }).includes("LINUX_CLIPBOARD"),
  );

  const beforeDrag = geometry();
  xdo("mousemove", "--window", id, "350", "20", "mousedown", "1");
  await pause(250);
  xdo("mousemove_relative", "--", "35", "20", "mouseup", "1");
  await waitFor("window moved by the titlebar", () => geometry().X > beforeDrag.X);

  await click("Focus terminal");
  await click("New terminal");
  await click("Split right, side by side");
  await click("New local terminal: Bash");
  await waitFor("two visible terminal panes", () =>
    execute(
      "return document.querySelectorAll('.terminal-workspace-pane-visible .xterm').length === 2",
    ),
  );

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
  const terminalPoint = await execute(
    "const box = document.querySelector('.terminal-workspace-pane.active .terminal-content').getBoundingClientRect(); return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];",
  );
  xdo("mousemove", "--window", id, ...terminalPoint.map(String), "click", "1");
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

  const closePoint = await execute(
    "const box = document.querySelector('.window-close-button').getBoundingClientRect(); return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];",
  );
  xdo("mousemove", "--window", id, ...closePoint.map(String), "click", "1");
  await waitFor("closed window", () => !windowId());
  assert.ok(existsSync(join(env.XDG_DATA_HOME, "app.controlroom.desktop", "control-room.db")));
  console.log(
    "Installed .deb opened, used the clipboard and split Bash panes, and exercised window controls under X11.",
  );
} catch (error) {
  // Report the cause here: a cleanup failure below must not replace it.
  console.error(error);
  try {
    // Tells an unmapped window apart from a missing or retitled one.
    console.error("Windows named Control Room:", xdo("search", "--name", "Control Room") || "none");
  } catch {
    console.error("No window is named Control Room");
  }
  if (session) {
    mkdirSync("test-results/linux-desktop", { recursive: true });
    const screenshot = await request("GET", "/session/" + session + "/screenshot").catch(
      () => null,
    );
    if (screenshot) {
      writeFileSync("test-results/linux-desktop/failure.png", Buffer.from(screenshot, "base64"));
    }
  }
  throw error;
} finally {
  if (session) await request("DELETE", "/session/" + session).catch(() => {});
  driver.kill();
  wm.kill();
  // The app can still be writing its data while it exits.
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
