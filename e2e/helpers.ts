import { $, browser, expect } from "@wdio/globals";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { application, isMac, localShellLabel } from "./platform";
import { recordMacApplication } from "./macos-processes";
import { sanitize } from "../scripts/sanitize-e2e-results.mjs";
import type { AppSettings, SavedConnection } from "../src/types";

export interface RuntimeStatus {
  appPid: number;
  sessionIds: string[];
  streamIds: string[];
}
let directory: string;
let macApplication: ChildProcess | undefined;

export async function stopMacApplication() {
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

export async function ipc<T>(command: string, args: object = {}): Promise<T> {
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

export async function restartApp(preserve = true) {
  const previous = await runtime();
  recordMacApplication(process.env.CONTROL_ROOM_E2E_DATA_DIR!, previous.appPid);
  appendFileSync(
    join(process.env.CONTROL_ROOM_E2E_DATA_DIR!, "app-pids.txt"),
    `${previous.appPid}\n`,
  );
  if (!preserve || !directory)
    directory = mkdtempSync(join(process.env.CONTROL_ROOM_E2E_DATA_DIR!, "case-"));
  if (isMac) {
    // The embedded server creates WebDriver sessions inside one app process;
    // reloadSession alone cannot prove native restart or database restoration.
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
    macApplication = spawn(application, [`--e2e-data-dir=${directory}`], {
      env: { ...process.env, TAURI_WEBDRIVER_PORT: String(port) },
      stdio: "ignore",
    });
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
  // First launch offers connection creation automatically. Tests set up their own data.
  if (await $("[role=dialog]").isExisting()) await $("[role=dialog]").$("button=Cancel").click();
  const current = await runtime();
  recordMacApplication(process.env.CONTROL_ROOM_E2E_DATA_DIR!, current.appPid);
  expect(current.appPid).not.toBe(previous.appPid);
  appendFileSync(
    join(process.env.CONTROL_ROOM_E2E_DATA_DIR!, "app-pids.txt"),
    `${current.appPid}\n`,
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
  writeFileSync(
    join(folder, "state.txt"),
    sanitize(
      `${title}\n${dom}\n${JSON.stringify(await runtime().catch(() => ({ unavailable: true })))}`,
    ),
  );
}

export async function addConnection(
  name: string,
  destination = "127.0.0.1",
  username = "tester",
  port = "1",
) {
  await $(".sidebar-primary").click();
  await $("aria/Display name").setValue(name);
  await $("aria/SSH destination").setValue(destination);
  await $("aria/Username").setValue(username);
  await $(".port-field input").setValue(port);
  await $(".modal-actions button[type=submit]").click();
  await expect($(`.host-main*=${name}`)).toBeDisplayed();
  return (await ipc<SavedConnection[]>("list_connections")).find(
    (connection) => connection.displayName === name,
  )!;
}

export async function connectionMenu(name: string) {
  const button = $(`aria/Open actions for ${name}`);
  await button.moveTo();
  await button.click();
}

// Offline fixtures cannot discover a platform. Complete the explicit Linux
// fallback before testing local workspace data or layout.
export async function openOfflineConnection(name: string, forceNew = false) {
  if (forceNew) {
    await $("aria/New terminal").click();
    await $(".new-terminal-menu").$(`button*=${name}`).click();
  } else {
    await $(`.host-main*=${name}`).click();
  }
  const dialog = $("[role=dialog]");
  if (await dialog.isExisting()) {
    await expect(dialog.$("h2")).toHaveText(`Connect to ${name}`);
    const fallback = dialog.$("button=Connect as Linux host");
    await fallback.waitForDisplayed({ timeout: 30_000 });
    await fallback.click();
    await dialog.waitForExist({ reverse: true });
  }
  await $("nav[aria-label='Workspace features']").waitForDisplayed();
}

export async function openLocal() {
  const launcher = $("button=Local terminal");
  if (await launcher.isDisplayed()) {
    await launcher.click();
  } else {
    await $("aria/New terminal").click();
  }
  await $(".local-shell-menu, .new-terminal-menu").$(`button*=${localShellLabel}`).click();
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
  // Embedded driver 1.5 dispatches both keydown and input for printable keys,
  // even when xterm prevents keydown's default. That types lowercase twice.
  // Element send-keys delivers one input event through the real xterm textarea.
  if (isMac) await $(`${scope} .xterm-helper-textarea`).addValue(text);
  else await browser.keys(text);
}

export async function focusElement(element: WebdriverIO.Element) {
  await element.click();
  // Embedded pointer actions emit mouse events without the browser's default
  // focus action. Explicit focus lets native keyboard resize tests use the handle.
  if (isMac) await browser.execute((node: HTMLElement) => node.focus(), element);
}

export async function pointerClick(element: WebdriverIO.Element) {
  if (isMac) {
    // Embedded driver 1.5 emits MouseEvents, but no PointerEvents. Exercise the
    // actual pane activation handler before the driver's ordinary click.
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

export async function terminalContains(marker: string, scope = ".terminal-workspace-pane.active") {
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
    { timeout: 15_000, timeoutMsg: `Terminal did not print ${marker}` },
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
