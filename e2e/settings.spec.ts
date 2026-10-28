import { isMac, localShellId, localShellLabel } from "./platform";
import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { ipc, openLocal, restartApp, runtime, savedSettings, terminalCommand } from "./helpers";

const font = () => $('[role="combobox"][aria-controls="font-suggestions"]');

async function enterFont(value: string) {
  await font().click();
  if (isMac) await font().setValue(value);
  else await browser.keys(value);
  await expect(font()).toHaveValue(value);
  await browser.keys("Enter");
}

describe("Settings and native window", () => {
  it("handles an empty metric request without loading a host and rejects duplicate selections", async () => {
    const sample = await ipc<{
      sampledAt: string;
      cpuPercent: number | null;
      diskLabel: string | null;
    }>("sample_header_metrics", { connectionId: "missing-host", metrics: [] });
    expect(Number.isFinite(Date.parse(sample.sampledAt))).toBe(true);
    expect(sample.cpuPercent).toBeNull();
    expect(sample.diskLabel).toBeNull();
    await expect(
      ipc("sample_header_metrics", { connectionId: "missing-host", metrics: ["cpu", "cpu"] }),
    ).rejects.toThrow(/unique/);
  });

  it("persists header metric choices and reads the local machine", async () => {
    await $("aria/Open Settings").click();
    await $(
      "//label[input[@type='checkbox']][contains(.,'Show host metrics in header')]/input",
    ).click();
    await $("//label[input[@type='checkbox']][normalize-space(.)='GPU']/input").click();
    await $("button=Save settings").click();
    await $("button[aria-label='Close Settings']").click();
    await openLocal();
    await expect(
      $('.host-metrics-trigger[aria-label$="Host metrics for Local machine"]'),
    ).toBeDisplayed();
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
    await expect(
      $('.host-metrics-trigger[aria-label$="Host metrics for Local machine"]'),
    ).toBeDisplayed();
    expect((await savedSettings()).hostMetricsEnabled).toBe(true);
    expect((await savedSettings()).hostMetrics).toEqual(["cpu", "ram", "diskIo", "uptime"]);
    await $("aria/Open Settings").click();
    await $(
      "//label[input[@type='checkbox']][contains(.,'Show host metrics in header')]/input",
    ).click();
    await $("button=Save settings").click();
    await $("button[aria-label='Close Settings']").click();
    await expect($(".host-metrics")).not.toExist();
  });

  it("dispatches native metric dragging while leaving the overflowing scrollbar interactive", async () => {
    await ipc("save_settings", {
      settings: { ...(await savedSettings()), hostMetricsEnabled: true },
    });
    await restartApp();
    await openLocal();
    await $(".host-metrics-values").waitForDisplayed();
    await browser.setWindowSize(1600, 900);
    for (const overflowing of [false, true, false]) {
      await browser.execute((narrow) => {
        document.querySelector<HTMLElement>(".host-metrics")!.style.maxWidth = narrow
          ? "340px"
          : "";
      }, overflowing);
      await browser.waitUntil(() =>
        browser.execute((narrow) => {
          const row = document.querySelector<HTMLElement>(".host-metrics-values")!;
          return (
            row.scrollWidth > row.clientWidth === narrow && row.hasAttribute("tabindex") === narrow
          );
        }, overflowing),
      );
      for (const selector of [
        ".host-metrics",
        ".host-metrics-values",
        ".host-metric",
        ".host-metric > span",
        ".host-metric > strong",
        ".host-metrics-status",
      ]) {
        // Observe the real native request. WebDriver cannot move the OS pointer.
        const calls = await browser.execute(async (target) => {
          const internals = (
            window as unknown as {
              __TAURI_INTERNALS__: {
                convertFileSrc: (command: string, protocol: string) => string;
              };
            }
          ).__TAURI_INTERNALS__;
          const dragUrl = internals.convertFileSrc("plugin:window|start_dragging", "ipc");
          const original = window.fetch;
          const requests: Promise<string>[] = [];
          window.fetch = (input, options) => {
            const request = original(input, options);
            if (String(input) === dragUrl)
              requests.push(
                request.then(async (response) =>
                  response.headers.get("Tauri-Response") === "ok" ? "ok" : response.clone().text(),
                ),
              );
            return request;
          };
          try {
            document
              .querySelector(target)!
              .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 }));
            return await Promise.all(requests);
          } finally {
            window.fetch = original;
          }
        }, selector);
        const interactive =
          selector === ".host-metrics-status" ||
          (overflowing && selector === ".host-metrics-values");
        expect(calls).toEqual(interactive ? [] : ["ok"]);
      }
    }
    await $(".host-metrics-trigger").click();
    await expect($(".host-metrics-panel")).toBeDisplayed();
    await $("aria/Close host metrics").click();
    await expect($(".host-metrics-panel")).not.toExist();
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
    await $("button[aria-label='Close Settings']").click();
    await openLocal();
    await terminalCommand("echo SETTINGS_TERMINAL_OK", "SETTINGS_TERMINAL_OK");
  });

  it("keeps dirty settings on cancellation and discards them only on confirmation", async () => {
    const original = (await savedSettings()).terminalFontFamily;
    await $("aria/Open Settings").click();
    await enterFont("Discard this draft");
    await $("button[aria-label='Close Settings']").click();
    await expect($("h2=Discard changes?")).toBeDisplayed();
    await $("button=Cancel").click();
    await expect(font()).toHaveValue("Discard this draft");
    await $("button[aria-label='Close Settings']").click();
    await $("button=Discard").click();
    await $("aria/Open Settings").click();
    await expect(font()).toHaveValue(original);
  });

  it("hides and restores the local shell in the launcher without uninstalling it", async () => {
    await $("aria/Open Settings").click();
    await $(`//label[input[@type='checkbox']][contains(.,'${localShellLabel}')]/input`).click();
    await $("button=Save settings").click();
    await $("button[aria-label='Close Settings']").click();
    await $("button=Local terminal").click();
    await expect($(`aria/${localShellLabel}`)).not.toExist();
    await browser.keys("Escape");
    await restartApp();
    await $("aria/Open Settings").click();
    await $(`//label[input[@type='checkbox']][contains(.,'${localShellLabel}')]/input`).click();
    await $("button=Save settings").click();
    await $("button[aria-label='Close Settings']").click();
    await openLocal();
    await terminalCommand("echo RESTORED_SHELL_OK", "RESTORED_SHELL_OK");
  });

  it(`${isMac ? "enters full screen" : "maximizes"} and restores actual native dimensions`, async () => {
    const maximized = () =>
      ipc<boolean>(isMac ? "plugin:window|is_fullscreen" : "plugin:window|is_maximized", {
        label: "main",
      });
    const dimensions = () =>
      ipc<{ width: number; height: number }>(
        isMac ? "plugin:window|outer_size" : "plugin:window|inner_size",
        { label: "main" },
      );
    const monitor = await ipc<{
      size: { width: number; height: number };
      workArea: { size: { width: number; height: number } };
    } | null>("plugin:window|current_monitor");
    expect(monitor).not.toBeNull();
    const before = await dimensions();
    const originalWindow = await browser.getWindowRect();
    if (isMac) await browser.fullscreenWindow();
    else await $("aria/Maximize or restore window").click();
    await browser.waitUntil(async () => (await maximized()) === true);
    // Mac full screen covers the display; Windows maximize fills its work area.
    const expected = isMac ? monitor!.size : monitor!.workArea.size;
    await browser.waitUntil(
      async () => {
        const expanded = await dimensions();
        return (
          Math.abs(expanded.width - expected.width) <= 2 &&
          Math.abs(expanded.height - expected.height) <= 2
        );
      },
      { timeoutMsg: "Expanded native window did not fill the expected monitor area" },
    );
    if (isMac)
      await browser.setWindowRect(
        originalWindow.x,
        originalWindow.y,
        originalWindow.width,
        originalWindow.height,
      );
    else await $("aria/Maximize or restore window").click();
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
        defaultLocalShellId: localShellId,
        hiddenLocalShells: catalog.profiles
          .filter((shell) => shell.id !== localShellId)
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
