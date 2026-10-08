import { $, browser, expect } from "@wdio/globals";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sanitize } from "../scripts/sanitize-e2e-results.mjs";
import type { AppSettings, SavedConnection } from "../src/types";

export interface RuntimeStatus {
  appPid: number;
  sessionIds: string[];
  streamIds: string[];
}
let directory: string;

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
  appendFileSync(
    join(process.env.CONTROL_ROOM_E2E_DATA_DIR!, "app-pids.txt"),
    `${previous.appPid}\n`,
  );
  if (!preserve || !directory)
    directory = mkdtempSync(join(process.env.CONTROL_ROOM_E2E_DATA_DIR!, "case-"));
  await browser.reloadSession({
    ...browser.requestedCapabilities,
    "tauri:options": {
      application: resolve(
        process.env.CARGO_TARGET_DIR ?? "src-tauri/target",
        "debug/control-room.exe",
      ),
      args: [`--e2e-data-dir=${directory}`],
    },
  } as unknown as WebdriverIO.Capabilities);
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

export async function openLocal() {
  const launcher = $("button=Local terminal");
  if (await launcher.isDisplayed()) {
    await launcher.click();
  } else {
    await $("button=New terminal").click();
  }
  await $(".local-shell-menu, .new-terminal-menu").$("button*=Command Prompt").click();
  await expect($(".terminal-workspace-pane.active .xterm-screen")).toBeDisplayed();
  await browser.waitUntil(async () => (await runtime()).sessionIds.length > 0);
}

export async function terminalCommand(
  command: string,
  marker: string,
  scope = ".terminal-workspace-pane.active",
) {
  await $(`${scope} .xterm-screen`).click();
  await browser.keys(command);
  await browser.keys("Enter");
  await terminalContains(marker, scope);
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
