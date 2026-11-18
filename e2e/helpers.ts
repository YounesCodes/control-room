import { $, browser, expect } from "@wdio/globals";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { application, isMac, isLinux, isWindows, localShellLabel } from "./platform";
import { recordMacApplication } from "./macos-processes";
import { sanitize } from "../scripts/sanitize-e2e-results.mjs";
import type { AppSettings, SavedConnection } from "../src/types";
import { recordApplication } from "./app-processes";

export interface RuntimeStatus {
  appPid: number;
  sessionIds: string[];
  streamIds: string[];
}
let directory: string;
let macApplication: ChildProcess | undefined;

async function stopMacApplication() {
  if (!macApplication || macApplication.exitCode !== null) return;
  const child = macApplication;
  const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await Promise.race([
    stopped,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("The owned macOS test app did not exit")), 20_000).unref(),
    ),
  ]);
  macApplication = undefined;
}

const macApplicationLog = resolve("test-results/desktop/driver/macos-app.log");

function openMacApplicationLog() {
  mkdirSync(resolve(macApplicationLog, ".."), { recursive: true });
  return openSync(macApplicationLog, "a");
}

export async function ipc<T>(command: string, args: object = {}): Promise<T> {
  // A WebDriver session can exist while its initial WebView document is still empty.
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          typeof (
            globalThis as unknown as {
              __TAURI__?: { core?: { invoke?: unknown } };
            }
          ).__TAURI__?.core?.invoke === "function",
      ),
    { timeout: 20_000, timeoutMsg: "Tauri bridge did not become ready" },
  );
  const result = await browser.execute(
    async (name, input) => {
      const native = (
        globalThis as unknown as {
          __TAURI__: { core: { invoke: (command: string, args: object) => Promise<unknown> } };
        }
      ).__TAURI__;
      try {
        return { ok: true, value: await native.core.invoke(name, input), error: "" };
      } catch (error) {
        return { ok: false, value: null, error: String(error) };
      }
    },
    command,
    args,
  );
  if (!result.ok) throw new Error(result.error);
  return result.value as T;
}
export const runtime = () => ipc<RuntimeStatus>("e2e_runtime_status");

function xprop(...args: string[]) {
  return execFileSync("xprop", ["-notype", ...args], { encoding: "utf8", timeout: 5000 });
}
export function managedLinuxWindow(pid: number) {
  const clients = xprop("-root", "_NET_CLIENT_LIST").match(/0x[0-9a-f]+/gi) ?? [];
  for (const id of clients) {
    let properties: string;
    try {
      properties = xprop("-id", id, "_NET_WM_PID", "_NET_WM_NAME");
    } catch {
      continue;
    }
    if (
      properties.match(/^_NET_WM_PID\D*(\d+)$/m)?.[1] === String(pid) &&
      /^_NET_WM_NAME[^"]*"Control Room"$/m.test(properties)
    )
      return id;
  }
  throw new Error(`No managed "Control Room" window belongs to process ${pid}`);
}
export async function restartApp(preserve = true) {
  const previous = await runtime();
  if (isMac) recordMacApplication(process.env.CONTROL_ROOM_E2E_DATA_DIR!, previous.appPid);
  else recordApplication(process.env.CONTROL_ROOM_E2E_DATA_DIR!, previous.appPid, application);
  if (!preserve || !directory)
    directory = mkdtempSync(join(process.env.CONTROL_ROOM_E2E_DATA_DIR!, "case-"));
  if (isMac) {
    // reloadSession alone cannot prove a native restart.
    await browser.deleteSession();
    if (macApplication) await stopMacApplication();
    else process.kill(previous.appPid, "SIGTERM");
    await browser.waitUntil(
      async () => {
        try {
          process.kill(previous.appPid, 0);
          return false;
        } catch {
          return true;
        }
      },
      { timeout: 20_000 },
    );
    const port = Number(browser.options.port || 4445);
    const appLog = openMacApplicationLog();
    macApplication = spawn(application, [`--e2e-data-dir=${directory}`], {
      env: { ...process.env, TAURI_WEBDRIVER_PORT: String(port) },
      stdio: ["ignore", appLog, appLog],
    });
    closeSync(appLog);
    macApplication.unref();
    await browser.waitUntil(
      async () => {
        if (macApplication?.exitCode !== null)
          throw new Error("macOS test app exited during startup");
        try {
          return (await fetch(`http://127.0.0.1:${port}/status`)).ok;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    );
  }
  await browser.reloadSession({
    ...browser.requestedCapabilities,
    "tauri:options": {
      application,
      args: [`--e2e-data-dir=${directory}`],
    },
  } as unknown as WebdriverIO.Capabilities);
  if (isMac) await ipc("plugin:window|set_focus", { label: "main" });
  await browser.waitUntil(
    async () => {
      try {
        process.kill(previous.appPid, 0);
        return false;
      } catch {
        return true;
      }
    },
    { timeout: 20_000, timeoutMsg: "The previous native application did not exit" },
  );
  await expect($("aria/Saved connections")).toExist();
  if (isLinux) await waitForSettledLinuxWindow();
  if (await $("[role=dialog]").isExisting()) await $("[role=dialog]").$("button=Cancel").click();
  const current = await runtime();
  if (isMac) recordMacApplication(process.env.CONTROL_ROOM_E2E_DATA_DIR!, current.appPid);
  else recordApplication(process.env.CONTROL_ROOM_E2E_DATA_DIR!, current.appPid, application);
  expect(current.appPid).not.toBe(previous.appPid);
}

async function waitForSettledLinuxWindow() {
  const pid = (await runtime()).appPid;
  await browser.waitUntil(
    () => {
      try {
        return Boolean(managedLinuxWindow(pid));
      } catch {
        return false;
      }
    },
    { timeout: 20_000, timeoutMsg: "The window manager did not manage the app window" },
  );
  let previous = "";
  await browser.waitUntil(
    async () => {
      const viewport = await browser.execute(() => `${innerWidth}x${innerHeight}`);
      const settled = viewport === previous;
      previous = viewport;
      return settled;
    },
    { timeout: 20_000, interval: 250, timeoutMsg: "The app viewport kept resizing after launch" },
  );
}

export async function cleanRuntime() {
  const state = await runtime();
  for (const id of state.streamIds)
    await ipc("stop_log_stream", { streamId: id }).catch(() => undefined);
  for (const id of state.sessionIds)
    await ipc("close_session", { sessionId: id }).catch(() => undefined);
  await browser.waitUntil(
    async () => {
      const current = await runtime();
      return current.sessionIds.length === 0 && current.streamIds.length === 0;
    },
    { timeout: 20_000, timeoutMsg: "Native sessions or log streams survived cleanup" },
  );
}

export async function captureFailure(title: string) {
  const folder = resolve(
    "test-results/desktop",
    `${Date.now()}-${title.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 80)}`,
  );
  mkdirSync(folder, { recursive: true });
  // Live screenshots stay local and may contain host facts. Only the deterministic workflow uploads artifacts.
  await browser.saveScreenshot(join(folder, "failure.png"));
  const dom = await browser.execute(
    () =>
      document.body.innerText.slice(0, 128_000) +
      "\n\n" +
      document.body.outerHTML.slice(0, 256_000),
  );
  const documentState = await browser.execute(() => ({
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    fonts: document.fonts?.status,
  }));
  writeFileSync(
    join(folder, "state.txt"),
    sanitize(
      `${title}\n${JSON.stringify(documentState)}\n${dom}\n${JSON.stringify(await runtime().catch(() => ({ unavailable: true })))}`,
    ),
  );
}

export async function openConnectionDialog() {
  await $(".sidebar-primary").click();
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const dialog = document.querySelector(".connection-dialog");
        return dialog !== null && dialog.getAnimations().length === 0;
      }),
    { timeoutMsg: "The connection dialog did not finish its entry animation" },
  );
}

export async function addConnection(
  name: string,
  destination = "127.0.0.1",
  username = "tester",
  port = "1",
) {
  await openConnectionDialog();
  await $("input[aria-label='Display name']").setValue(name);
  await $("input[aria-label='SSH destination']").setValue(destination);
  await $("input[aria-label='Username']").setValue(username);
  await $("//label[span[normalize-space()='Port']]/input").setValue(port);
  await $(".modal-actions button[type=submit]").click();
  await expect($(`.host-main*=${name}`)).toBeDisplayed();
  return (await ipc<SavedConnection[]>("list_connections")).find(
    (connection) => connection.displayName === name,
  )!;
}

export async function connectionMenu(name: string) {
  const button = $(`aria/Open actions for ${name}`);
  if (isLinux) await browser.execute((node: HTMLElement) => node.focus(), await button);
  else await button.moveTo();
  await button.click();
}

export async function openOfflineConnection(name: string, forceNew = false) {
  if (forceNew) {
    await $('button[aria-label="New terminal"]').click();
    await $(".new-terminal-menu").$(`button*=${name}`).click();
  } else {
    await $(`.host-main*=${name}`).click();
  }
  const dialog = $(".modal-backdrop [role=dialog]");
  if (await dialog.isExisting()) {
    await expect(dialog.$("h2")).toHaveText(`Connect to ${name}`);
    const fallback = dialog.$(
      ".//button[normalize-space()='Open default SSH shell' or normalize-space()='Connect as Linux host']",
    );
    await fallback.waitForDisplayed({ timeout: 30_000 });
    await fallback.click();
    await dialog.waitForExist({ reverse: true });
  }
  await $("nav[aria-label='Workspace features']").waitForDisplayed();
}

export async function openLocal(shellLabel = localShellLabel) {
  await $('button[aria-label="New terminal"]').click();
  await $(".new-terminal-menu").$(`aria/Local terminals: ${shellLabel}`).click();
  await expect($(".terminal-workspace-pane.active .xterm-screen")).toBeDisplayed();
  await browser.waitUntil(async () => (await runtime()).sessionIds.length > 0);
}

export async function terminalCommand(
  command: string,
  marker: string,
  scope = ".terminal-workspace-pane.active",
) {
  await $(`${scope} .xterm-screen`).click();
  await typeTerminalText(command, scope);
  await browser.keys("Enter");
  await terminalContains(marker, scope);
}

export async function typeTerminalText(text: string, scope = ".terminal-workspace-pane.active") {
  // WebKit's driver dispatches keydown and input for printable keys, which xterm types twice.
  if (!isWindows) await $(`${scope} .xterm-helper-textarea`).addValue(text);
  else await browser.keys(text);
}

export async function focusElement(element: WebdriverIO.Element) {
  // Frameless Linux resize edges can cover a divider at its maximum width.
  if (!isLinux) await element.click();
  // Embedded pointer actions skip the browser's default focus action.
  if (!isWindows) await browser.execute((node: HTMLElement) => node.focus(), element);
}

export async function pointerClick(element: WebdriverIO.Element) {
  if (isMac) {
    // Embedded driver 1.5 emits MouseEvents but no PointerEvents.
    await browser.execute((node: HTMLElement) => {
      const bounds = node.getBoundingClientRect();
      for (const type of ["pointerdown", "pointerup"])
        node.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            button: 0,
            clientX: bounds.left + bounds.width / 2,
            clientY: bounds.top + bounds.height / 2,
          }),
        );
    }, element);
  }
  await element.click();
}

export async function pressBoundaryKey(
  key: "Home" | "End" | "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
  shift = false,
) {
  if (!isMac) return browser.keys(shift ? ["Shift", key, "NULL"] : key);
  // Embedded driver 1.5 omits Home/End and drops modifiers on special keys.
  await browser.execute(
    (name, shifted) => {
      const target = document.activeElement ?? document.body;
      const codes = {
        Home: 36,
        End: 35,
        ArrowLeft: 37,
        ArrowRight: 39,
        ArrowUp: 38,
        ArrowDown: 40,
      };
      for (const type of ["keydown", "keyup"])
        target.dispatchEvent(
          new KeyboardEvent(type, {
            key: name,
            code: name,
            keyCode: codes[name],
            which: codes[name],
            shiftKey: shifted,
            bubbles: true,
            cancelable: true,
          }),
        );
    },
    key,
    shift,
  );
}

export async function terminalContains(
  marker: string,
  scope = ".terminal-workspace-pane.active",
  timeout = 15_000,
) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (selector, expected) =>
          Array.from(document.querySelectorAll(`${selector} .xterm-rows > div`), (row) =>
            row.textContent?.trim(),
          ).includes(expected),
        scope,
        marker,
      ),
    { timeout, timeoutMsg: `Terminal did not print ${marker}` },
  );
}

export async function closeWorkspace(label: string, confirm = "Stop & close") {
  await $(".session-tab-wrap.active .session-tab-main").moveTo();
  const close = $(".session-tab-wrap.active .session-tab-close");
  await expect(close).toHaveAttribute("aria-label", expect.stringContaining(`Close ${label}`));
  await close.click();
  if (await $("[role=dialog]").isExisting()) await $(`button=${confirm}`).click();
}

export async function savedSettings() {
  return (await ipc<{ current: AppSettings }>("get_settings_contract")).current;
}

export async function feature(label: string) {
  await $("nav[aria-label='Workspace features']").$(`button=${label}`).click();
}

export async function activateFocusedButton() {
  if (isMac) await browser.execute(() => (document.activeElement as HTMLButtonElement).click());
  else await browser.keys("Enter");
}

export async function openScratchpad() {
  await feature("Terminal");
  const trigger = $("[data-scratchpad-trigger]");
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await scratchpadNote();
}

export async function scratchpadNote() {
  const note = $(".scratchpad-popover-note:not([hidden])");
  const editor = note.$("textarea");
  await editor.waitForDisplayed();
  await browser.waitUntil(async () => (await editor.getAttribute("readonly")) === null);
  return note;
}

export async function openSplitMenu(direction: "vertically" | "horizontally" = "vertically") {
  await browser.waitUntil(() =>
    browser.execute(() => !document.documentElement.dataset.focusTransition),
  );
  await $("aria/New terminal").click();
  await $(".new-terminal-menu").waitForDisplayed();
  await $(".new-terminal-menu")
    .$(`button*=${direction === "vertically" ? "Split right" : "Split down"}`)
    .click();
}

// WebKitWebDriver returns empty getText for these visible flex tab labels.
export async function expectNativeText(element: WebdriverIO.Element, text: string) {
  await expect(element).toBeDisplayed();
  if (!isLinux) return expect(element).toHaveText(text);
  await browser.waitUntil(
    async () => String((await element.getProperty("textContent")) ?? "").trim() === text,
    {
      timeoutMsg: `Native label did not become ${text}`,
    },
  );
}
