import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { ipc, openLocal, restartApp, runtime, savedSettings, terminalCommand } from "./helpers";

const font = () => $('[role="combobox"][aria-controls="font-suggestions"]');

async function enterFont(value: string) {
  await font().click();
  await browser.keys(value);
  await expect(font()).toHaveValue(value);
  await browser.keys("Enter");
}

describe("Settings and native window", () => {
  it("persists header metric choices and reads the local machine", async () => {
    await $("aria/Open Settings").click();
    await $(
      "//label[input[@type='checkbox']][contains(.,'Show host metrics in header')]/input",
    ).click();
    await $("//label[input[@type='checkbox']][normalize-space(.)='GPU']/input").click();
    await $("button=Save settings").click();
    await $("aria/Close Settings").click();
    await openLocal();
    await expect($("aria/Host metrics for Local machine")).toBeDisplayed();
    await browser.waitUntil(async () => (await $(".host-metrics-status").getText()) === "Live");
    const native = await ipc<{
      cpuPercent: number;
      memoryTotalKib: number;
      diskTotalKib: number;
      uptimeSeconds: number;
    }>("sample_header_metrics", { connectionId: null, metrics: ["cpu", "ram", "disk", "uptime"] });
    expect(native.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(native.cpuPercent).toBeLessThanOrEqual(100);
    expect(native.memoryTotalKib).toBeGreaterThan(0);
    expect(native.diskTotalKib).toBeGreaterThan(0);
    expect(native.uptimeSeconds).toBeGreaterThanOrEqual(0);
    await restartApp();
    await expect($("aria/Host metrics for Local machine")).toBeDisplayed();
    expect((await savedSettings()).hostMetricsEnabled).toBe(true);
    expect((await savedSettings()).hostMetrics).toEqual(["cpu", "ram", "disk", "uptime"]);
    await $("aria/Open Settings").click();
    await $(
      "//label[input[@type='checkbox']][contains(.,'Show host metrics in header')]/input",
    ).click();
    await $("button=Save settings").click();
    await $("aria/Close Settings").click();
    await expect($(".host-metrics")).not.toExist();
  });

  it("saves terminal settings and restores them after a native app restart", async () => {
    expect((await savedSettings()).automaticUpdateChecks).toBe(false);
    await $("aria/Open Settings").click();
    await enterFont("Courier New");
    await $("button=Save settings").click();
    await expect($(".settings-heading [role=status]")).toHaveText("Settings saved.");
    await restartApp();
    await $("aria/Open Settings").click();
    await expect(font()).toHaveValue("Courier New");
    await $("aria/Close Settings").click();
    await openLocal();
    await terminalCommand("echo SETTINGS_TERMINAL_OK", "SETTINGS_TERMINAL_OK");
  });

  it("keeps dirty settings on cancellation and discards them only on confirmation", async () => {
    const original = (await savedSettings()).terminalFontFamily;
    await $("aria/Open Settings").click();
    await enterFont("Discard this draft");
    await $("aria/Close Settings").click();
    await expect($("h2=Discard changes?")).toBeDisplayed();
    await $("button=Cancel").click();
    await expect(font()).toHaveValue("Discard this draft");
    await $("aria/Close Settings").click();
    await $("button=Discard").click();
    await $("aria/Open Settings").click();
    await expect(font()).toHaveValue(original);
  });

  it("hides and restores Command Prompt in the launcher without uninstalling it", async () => {
    await $("aria/Open Settings").click();
    await $("//label[input[@type='checkbox']][contains(.,'Command Prompt')]/input").click();
    await $("button=Save settings").click();
    await $("aria/Close Settings").click();
    await $("button=Local terminal").click();
    await expect($("aria/Command Prompt")).not.toExist();
    await browser.keys("Escape");
    await restartApp();
    await $("aria/Open Settings").click();
    await $("//label[input[@type='checkbox']][contains(.,'Command Prompt')]/input").click();
    await $("button=Save settings").click();
    await $("aria/Close Settings").click();
    await openLocal();
    await terminalCommand("echo RESTORED_SHELL_OK", "RESTORED_SHELL_OK");
  });

  it("maximizes and restores actual native dimensions", async () => {
    const maximized = () =>
      browser.tauri.execute(({ core }) =>
        core.invoke("plugin:window|is_maximized", { label: "main" }),
      );
    const dimensions = () =>
      ipc<{ width: number; height: number }>("plugin:window|inner_size", { label: "main" });
    const monitor = await ipc<{ workArea: { size: { width: number; height: number } } } | null>(
      "plugin:window|current_monitor",
    );
    expect(monitor).not.toBeNull();
    const before = await dimensions();
    await $("aria/Maximize or restore window").click();
    await browser.waitUntil(async () => (await maximized()) === true);
    // Maximizing fills the work area, even if the initial window exceeds a small CI display.
    await browser.waitUntil(
      async () => {
        const expanded = await dimensions();
        return (
          Math.abs(expanded.width - monitor!.workArea.size.width) <= 2 &&
          Math.abs(expanded.height - monitor!.workArea.size.height) <= 2
        );
      },
      { timeoutMsg: "Maximized native window did not fill the monitor work area" },
    );
    await $("aria/Maximize or restore window").click();
    await browser.waitUntil(async () => (await maximized()) === false);
    await browser.waitUntil(
      async () => {
        const restored = await dimensions();
        return (
          Math.abs(restored.width - before.width) <= 2 &&
          Math.abs(restored.height - before.height) <= 2
        );
      },
      { timeoutMsg: "Restored native window did not recover its original dimensions" },
    );
  });
});

describe("Local Terminal Mode desktop", () => {
  it("starts the selected shell in normal Focus Mode, restores Connections on exit and reuses workspaces", async () => {
    const settings = await savedSettings();
    const catalog = await ipc<{ profiles: { id: string }[] }>("list_local_shells");
    await ipc("save_settings", {
      settings: {
        ...settings,
        localTerminalMode: true,
        defaultLocalShellId: "command-prompt",
        hiddenLocalShells: catalog.profiles
          .filter((shell) => shell.id !== "command-prompt")
          .map((shell) => shell.id),
      },
    });
    await restartApp();
    await expect($(".app-shell")).toHaveAttribute("class", "app-shell terminal-focus-mode");
    await expect($(".sidebar")).not.toBeDisplayed();
    await expect($("aria/New terminal")).toBeDisplayed();
    await terminalCommand("echo CONTROL_ROOM_LOCAL_MODE_OK", "CONTROL_ROOM_LOCAL_MODE_OK");
    expect((await runtime()).sessionIds).toHaveLength(1);
    await $("aria/Exit terminal focus").click();
    await expect($("aria/Saved connections")).toBeDisplayed();
    await $("button=Local terminal").click();
    await expect($(".local-shell-menu")).not.toExist();
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 2);
    await $("button=Add connection").click();
    await expect($("[role=dialog]")).toBeDisplayed();
    await browser.keys("Escape");
    await browser.waitUntil(
      async () =>
        (await ipc<{ workspaces: unknown[] }>("get_workspace_state")).workspaces.length === 2,
    );
    await restartApp();
    await expect($(".app-shell")).toHaveAttribute("class", "app-shell terminal-focus-mode");
    await expect($(".sidebar")).not.toBeDisplayed();
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 2);
    expect(await browser.execute(() => document.querySelectorAll(".session-tab-wrap").length)).toBe(
      2,
    );
  });
});
