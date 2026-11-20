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
  // WebKit helper processes outlive the window and keep writing a shader cache.
  MESA_SHADER_CACHE_DISABLE: "true",
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

// Maximize state can trail the X geometry by a few milliseconds.
async function maximized() {
  const value = await request("POST", "/session/" + session + "/execute/async", {
    script:
      "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('plugin:window|is_maximized', { label: 'main' }).then(done, (error) => done({ error: String(error) }));",
    args: [],
  });
  if (typeof value !== "boolean") throw new Error("is_maximized failed: " + JSON.stringify(value));
  return value;
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

// A hidden window holds Web Animations until it is shown again.
async function settledPoint(label, script) {
  let previous = "";
  let point;
  await waitFor("settled " + label, async () => {
    const sample = await execute(
      `if (document.visibilityState !== "visible") return null;
      const moving = document.getAnimations().some((animation) =>
        animation.playState === "running" &&
        animation.effect?.getComputedTiming().endTime !== Infinity);
      if (moving) return null;
      ${script}`,
    );
    const key = JSON.stringify(sample);
    const stable = sample !== null && key === previous;
    previous = key;
    point = sample;
    return stable;
  });
  return point.map(String);
}

function center(selector) {
  return `const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];`;
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
  // A window mapped while Openbox is starting can stay unmanaged.
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
  const outputPoint = await settledPoint(
    "clipboard output",
    "const row = Array.from(document.querySelectorAll('.terminal-workspace-pane.active .xterm-rows > div')).find(el => el.textContent.includes('LINUX_CLIPBOARD')); const box = row.getBoundingClientRect(); return [Math.round(box.x + 6), Math.round(box.y + box.height / 2)];",
  );
  xdo("mousemove", "--window", id, ...outputPoint, "click", "--repeat", "2", "1");
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
  // Openbox can deliver a late resize after the titlebar drag, which dismisses the menu.
  await waitFor("Split right, side by side", async () => {
    const menuOpen = await execute(
      "return document.querySelector('button[aria-label=\"New terminal\"]')?.getAttribute('aria-expanded') === 'true'",
    );
    if (!menuOpen) await click("New terminal");
    return execute(
      "return !!document.querySelector('button[aria-label=\"Split right, side by side\"]:not([disabled])')?.offsetWidth",
    );
  });
  await click("Split right, side by side");
  await click("New local terminal: Bash");
  await waitFor("two visible terminal panes", () =>
    execute(
      "return document.querySelectorAll('.terminal-workspace-pane-visible .xterm').length === 2",
    ),
  );

  const viewportWidth = () => execute("return innerWidth");
  const initial = width();
  const initialViewport = await viewportWidth();
  await click("Maximize or restore window");
  await waitFor(
    "maximized window",
    async () =>
      width() > initial && (await maximized()) && (await viewportWidth()) > initialViewport,
  );
  await settledPoint("maximized layout", center("button[aria-label='Maximize or restore window']"));
  await click("Maximize or restore window");
  await waitFor(
    "restored window",
    async () =>
      width() === initial && !(await maximized()) && (await viewportWidth()) === initialViewport,
  );

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

  // A WebDriver click can wait for a rendering update that a minimized page never produces.
  const minimizePoint = await settledPoint(
    "minimize button",
    center("button[aria-label='Minimize window']"),
  );
  xdo("mousemove", "--window", id, ...minimizePoint, "click", "1");
  await waitFor("minimized window", () => !windowId());
  xdo("windowactivate", "--sync", id);
  await waitFor("restored window after minimize", () => windowId() === id);
  const terminalPoint = await settledPoint(
    "restored terminal",
    center(".terminal-workspace-pane.active .terminal-content"),
  );
  xdo("mousemove", "--window", id, ...terminalPoint, "click", "1");
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

  const closePoint = await settledPoint("close button", center(".window-close-button"));
  xdo("mousemove", "--window", id, ...closePoint, "click", "1");
  await waitFor("closed window", () => !windowId());
  assert.ok(existsSync(join(env.XDG_DATA_HOME, "app.controlroom.desktop", "control-room.db")));
  console.log(
    "Installed .deb opened, used the clipboard and split Bash panes, and exercised window controls under X11.",
  );
} catch (error) {
  console.error(error);
  if (session) {
    const page = await execute(
      "return { visibility: document.visibilityState, focused: document.hasFocus(), active: document.activeElement?.className || document.activeElement?.nodeName, viewport: innerWidth + 'x' + innerHeight };",
    ).catch((cause) => "unavailable: " + cause.message);
    console.error("Page state:", page);
  }
  try {
    const windows = xdo("search", "--name", "Control Room");
    console.error("Windows named Control Room:", windows || "none");
    for (const window of windows.split("\n").filter(Boolean))
      console.error(window, xdo("getwindowgeometry", "--shell", window).replaceAll("\n", " "));
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
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
