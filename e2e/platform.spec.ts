import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { focusElement, ipc, openLocal, pressBoundaryKey, terminalCommand } from "./helpers";
import { isMac, localShellId } from "./platform";
import type { EnvironmentInfo, LocalShellCatalog } from "../src/types";

describe("Native client platform", () => {
  it("uses native platform tools, window chrome, and application shortcuts", async () => {
    const environment = await ipc<EnvironmentInfo>("get_environment_info");
    expect(environment.platform).toBe(isMac ? "macos" : "windows");
    expect(environment.platformSupported).toBe(true);
    expect(environment.sshPath).toBeTruthy();
    expect(await ipc<boolean>("plugin:window|is_decorated", { label: "main" })).toBe(isMac);
    const catalog = await ipc<LocalShellCatalog>("list_local_shells");
    expect(catalog.profiles.some((shell) => shell.id === localShellId)).toBe(true);
    if (isMac) {
      expect(environment.sshPath).toBe("/usr/bin/ssh");
      expect(catalog.profiles.every((shell) => !shell.elevated)).toBe(true);
      await expect($("aria/Window controls")).not.toExist();
      // Overlay chrome keeps the webview as tall as the native window. A
      // separate system titlebar would reduce its content height.
      const outer = await ipc<{ width: number; height: number }>("plugin:window|outer_size", {
        label: "main",
      });
      const inner = await ipc<{ width: number; height: number }>("plugin:window|inner_size", {
        label: "main",
      });
      expect(Math.abs(outer.height - inner.height)).toBeLessThanOrEqual(1);
    } else {
      await expect($("aria/Window controls")).toBeDisplayed();
    }
    await openLocal();
    await terminalCommand("echo NATIVE_CLIENT_READY", "NATIVE_CLIENT_READY");
    await browser.keys([isMac ? "Meta" : "Control", "Shift", "p"]);
    await browser.keys("NULL");
    await expect($("[role=combobox][aria-label='Search commands']")).toBeDisplayed();
    await browser.keys("Escape");
    await terminalCommand("echo PALETTE_RETURNED_INPUT", "PALETTE_RETURNED_INPUT");
  });

  (isMac ? it : it.skip)(
    "realigns native frame changes and removes observers before window teardown",
    async () => {
      const result = await ipc<{
        windowsBefore: number;
        windowsObserved: number;
        windowsAfterClose: number;
        centersAfterContainerChange: number[];
        centersAfterButtonChange: number[];
        unobservedDelta: number;
      }>("e2e_window_chrome_lifecycle");
      const center = await browser.execute(() => {
        const bar = document.querySelector<HTMLElement>(".app-bar")!;
        return bar.getBoundingClientRect().top + bar.clientHeight / 2;
      });
      expect(result.windowsBefore).toBe(1);
      expect(result.windowsObserved).toBe(2);
      expect(result.windowsAfterClose).toBe(1);
      for (const actual of [
        ...result.centersAfterContainerChange,
        ...result.centersAfterButtonChange,
      ]) {
        expect(Math.abs(actual - center)).toBeLessThanOrEqual(0.5);
      }
      expect(result.unobservedDelta).toBe(7);
    },
  );

  (isMac ? it : it.skip)(
    "keeps one native Mac header through resize, sidebar collapse, Settings, and full screen",
    async () => {
      const original = await browser.getWindowRect();
      const headerFits = async (mode: "normal" | "focus" | "settings") => {
        // Native NSButtons live outside the DOM. Compare their actual centers
        // with the HTML header so this also catches a wrong Tauri inset.
        if (!(await ipc<boolean>("plugin:window|is_fullscreen", { label: "main" }))) {
          const buttons =
            await ipc<
              { name: string; left: number; centerY: number; width: number; height: number }[]
            >("e2e_window_buttons");
          const center = await browser.execute((layout) => {
            const bar = document.querySelector<HTMLElement>(
              layout === "focus" ? ".session-tabs" : ".app-bar",
            )!;
            return bar.getBoundingClientRect().top + bar.clientHeight / 2;
          }, mode);
          expect(buttons.map((button) => button.name)).toEqual(["close", "minimize", "fullscreen"]);
          for (const button of buttons) {
            if (!(Math.abs(button.centerY - center) <= 0.5)) {
              throw new Error(
                `Native button centers in ${mode}: ${JSON.stringify({ expected: center, buttons })}`,
              );
            }
            expect(button.width).toBeGreaterThanOrEqual(12);
            expect(button.height).toBeGreaterThanOrEqual(12);
          }
          expect(buttons[0].left).toBe(16);
          expect(buttons[1].left).toBeGreaterThan(buttons[0].left + buttons[0].width);
          expect(buttons[2].left).toBeGreaterThan(buttons[1].left + buttons[1].width);
          expect(buttons[2].left + buttons[2].width).toBeLessThan(104);
        }
        return browser.execute((layout) => {
          const shell = document.querySelector<HTMLElement>(".app-shell")!;
          const bar = shell.querySelector<HTMLElement>(
            layout === "focus" ? ".session-tabs" : ".app-bar",
          )!;
          const bounds = bar.getBoundingClientRect();
          if (
            bounds.left !== 1 ||
            bounds.top !== 1 ||
            bounds.height !== 42 ||
            bounds.right !== window.innerWidth - 1 ||
            getComputedStyle(bar).paddingLeft !== "104px"
          ) {
            return false;
          }
          const sidebar = shell.querySelector<HTMLElement>(".sidebar")!;
          const workspace = shell.querySelector<HTMLElement>(".workspace-shell")!;
          if (layout === "focus") {
            const tab = bar.querySelector<HTMLElement>(".session-tab-wrap")!;
            const drag = bar.querySelector<HTMLElement>(".session-window-drag-region")!;
            return (
              sidebar.getBoundingClientRect().height === 0 &&
              shell.querySelector<HTMLElement>(".app-bar")!.getBoundingClientRect().height === 0 &&
              tab.getBoundingClientRect().left >= 104 &&
              drag.getBoundingClientRect().height === 6
            );
          }
          if (workspace.getBoundingClientRect().top !== bounds.bottom) return false;
          if (layout === "settings") {
            return (
              sidebar.getBoundingClientRect().height === 0 &&
              !bar.querySelector(".sidebar-top-heading")
            );
          }
          const heading = bar.querySelector<HTMLElement>(".sidebar-top-heading")!;
          const label = heading.querySelector<HTMLElement>("span")!;
          const count = heading.querySelectorAll("span")[1];
          const reset = heading.querySelector<HTMLElement>(".layout-reset")!;
          return (
            sidebar.getBoundingClientRect().top === bounds.bottom &&
            sidebar.querySelector(".connections-divider")!.getBoundingClientRect().top ===
              bounds.bottom &&
            label.getBoundingClientRect().left >= 104 &&
            label.scrollWidth <= label.clientWidth &&
            getComputedStyle(count).display !== "none" &&
            reset.getBoundingClientRect().left >= label.getBoundingClientRect().right
          );
        }, mode);
      };

      await browser.setWindowRect(original.x, original.y, 960, 640);
      await browser.waitUntil(() => headerFits("normal"));
      await focusElement(await $("aria/Resize Connections panel"));
      await pressBoundaryKey("Home");
      await expect($("aria/Resize Connections panel")).toHaveAttribute("aria-valuenow", "200");
      await browser.waitUntil(() => headerFits("normal"));
      await pressBoundaryKey("End");
      await expect($("aria/Resize Connections panel")).toHaveAttribute("aria-valuenow", "480");
      await browser.waitUntil(() => headerFits("normal"));
      await browser.setWindowRect(original.x, original.y, original.width, original.height);
      await $("aria/Reset layout").click();
      await browser.waitUntil(() => headerFits("normal"));

      await openLocal();
      await $("aria/Focus terminal").click();
      await browser.waitUntil(() => headerFits("focus"));
      await browser.fullscreenWindow();
      await browser.waitUntil(() => ipc<boolean>("plugin:window|is_fullscreen", { label: "main" }));
      await browser.waitUntil(() => headerFits("focus"));
      await browser.setWindowRect(original.x, original.y, original.width, original.height);
      await browser.waitUntil(
        async () => !(await ipc<boolean>("plugin:window|is_fullscreen", { label: "main" })),
      );
      await browser.waitUntil(() => headerFits("focus"));
      await $("aria/Exit terminal focus").click();
      await browser.waitUntil(() => headerFits("normal"));
      await $("aria/Open Settings").click();
      await browser.waitUntil(() => headerFits("settings"));
      await $("button[aria-label='Close Settings']").click();
      await browser.waitUntil(() => headerFits("normal"));
    },
  );
});
