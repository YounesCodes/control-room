import { isMac } from "./platform";
import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import {
  addConnection,
  feature,
  ipc,
  openOfflineConnection,
  restartApp,
  focusElement,
  pressBoundaryKey,
} from "./helpers";
import type { PersistedWorkspaceState } from "../src/types";

describe("Resizable panels in the native app", () => {
  it(`fills Scratchpad when the native window is ${isMac ? "full screen" : "maximized"} and restored`, async () => {
    await addConnection("Scratchpad host");
    await openOfflineConnection("Scratchpad host");
    await feature("Scratchpad");
    await $(".scratchpad-editor textarea").waitForDisplayed();
    const fillsWorkspace = () =>
      browser.execute(() => {
        const section = document.querySelector<HTMLElement>(".connection-section")!;
        const content = document.querySelector<HTMLElement>(".connection-section-content")!;
        const pad = document.querySelector<HTMLElement>(".scratchpad-page")!;
        const editor = document.querySelector<HTMLElement>(".scratchpad-editor")!;
        const style = getComputedStyle(pad);
        const available =
          pad.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return (
          Math.abs(section.clientWidth - content.clientWidth) <= 1 &&
          Math.abs(editor.clientWidth - available) <= 1
        );
      });
    await browser.waitUntil(fillsWorkspace);
    const originalWindow = await browser.getWindowRect();
    const expanded = () =>
      ipc<boolean>(isMac ? "plugin:window|is_fullscreen" : "plugin:window|is_maximized", {
        label: "main",
      });
    // The normal Mac traffic-light action enters full screen. Windows uses
    // maximize; AppKit's optional zoom has different standard-frame semantics.
    if (isMac) await browser.fullscreenWindow();
    else await $("aria/Maximize or restore window").click();
    await browser.waitUntil(expanded);
    await browser.waitUntil(fillsWorkspace);
    if (isMac)
      await browser.setWindowRect(
        originalWindow.x,
        originalWindow.y,
        originalWindow.width,
        originalWindow.height,
      );
    else await $("aria/Maximize or restore window").click();
    await browser.waitUntil(async () => !(await expanded()));
    await browser.waitUntil(fillsWorkspace);
  });
  it("resizes and saves the Connections width through SQLite and resets it", async () => {
    const divider = $("aria/Resize Connections panel");
    const defaultWidth = await divider.getAttribute("aria-valuenow");
    if (isMac) {
      await focusElement(await divider);
      for (let i = 0; i < 2; i++) await pressBoundaryKey("ArrowRight", true);
    } else await divider.dragAndDrop({ x: 100, y: 0 });
    const chosen = Number(await divider.getAttribute("aria-valuenow"));
    expect(chosen).toBeGreaterThan(300);
    await browser.waitUntil(async () => {
      const state = (await browser.tauri.execute(({ core }) =>
        core.invoke("get_workspace_state"),
      )) as { panelSizes: Record<string, number> };
      return state.panelSizes.connections === chosen;
    });
    await restartApp();
    await expect($("aria/Resize Connections panel")).toHaveAttribute(
      "aria-valuenow",
      String(chosen),
    );
    await $("aria/Reset layout").click();
    await browser.waitUntil(async () => {
      const state = (await browser.tauri.execute(({ core }) =>
        core.invoke("get_workspace_state"),
      )) as { panelSizes: Record<string, number> };
      return Object.keys(state.panelSizes).length === 0;
    });
    await restartApp();
    await expect($("aria/Resize Connections panel")).toHaveAttribute("aria-valuenow", defaultWidth);
  });

  it("saves content and split widths, shares them across hosts, restores and resets through SQLite", async () => {
    const create = async (name: string) => {
      await $(".sidebar-primary").click();
      await $("aria/Display name").setValue(name);
      await $("aria/SSH destination").setValue("127.0.0.1");
      await $("aria/Username").setValue("tester");
      await $(".port-field input").setValue("1");
      await $(".modal-actions button[type=submit]").click();
    };
    await create("Layout host A");
    await create("Layout host B");
    await openOfflineConnection("Layout host A");
    const openBaselines = async () => {
      await $("nav[aria-label='Workspace features']").$("button=Baselines").click();
    };
    await openBaselines();
    let content = await $("aria/Resize Baselines content");
    await focusElement(await content);
    await browser.keys("ArrowLeft");
    const contentWidth = Number(await content.getAttribute("aria-valuenow"));
    let split = await $("aria/Resize Baselines panes");
    await focusElement(await split);
    await pressBoundaryKey("ArrowLeft", true);
    const splitWidth = Number(await split.getAttribute("aria-valuenow"));
    const saved = async () =>
      (await browser.tauri.execute(({ core }) => core.invoke("get_workspace_state"))) as {
        panelSizes: Record<string, number>;
      };
    await browser.waitUntil(async () => {
      const state = await saved();
      return (
        state.panelSizes["content:baselines"] === contentWidth &&
        state.panelSizes["split:Baselines"] === splitWidth
      );
    });
    await openOfflineConnection("Layout host B");
    await openBaselines();
    await expect(split).toHaveAttribute("aria-valuenow", String(splitWidth));
    // View changes use the same debounced save as tab state. Wait for that
    // write before terminating the process to test restoration deterministically.
    await browser.waitUntil(async () => {
      const state = await ipc<{
        activeWorkspaceId: string;
        workspaces: { id: string; view: string }[];
      }>("get_workspace_state");
      return (
        state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId)?.view ===
        "baselines"
      );
    });
    await restartApp();
    // Embedded find-elements uses shared temporary storage. Resolve selectors
    // sequentially so concurrent queries cannot exchange the two dividers.
    content = await $("aria/Resize Baselines content");
    split = await $("aria/Resize Baselines panes");
    await expect(content).toHaveAttribute("aria-valuenow", String(contentWidth));
    await expect(split).toHaveAttribute("aria-valuenow", String(splitWidth));
    const window = await browser.getWindowRect();
    await browser.setWindowSize(960, 640);
    await browser.waitUntil(
      async () => Number(await content.getAttribute("aria-valuenow")) < contentWidth,
    );
    expect((await saved()).panelSizes["content:baselines"]).toBe(contentWidth);
    await browser.setWindowSize(window.width, window.height);
    await expect(content).toHaveAttribute("aria-valuenow", String(contentWidth));
    if (isMac) {
      await focusElement(await split);
      await browser.keys("Enter");
    } else await split.doubleClick();
    await browser.waitUntil(async () => !("split:Baselines" in (await saved()).panelSizes));
    await $("aria/Reset layout").click();
    await browser.waitUntil(async () => Object.keys((await saved()).panelSizes).length === 0);
    for (const name of ["Layout host A", "Layout host B"]) {
      const menu = $("aria/Open actions for " + name);
      await menu.moveTo();
      if (!isMac) await menu.waitForClickable();
      await menu.click();
      await $("aria/Delete connection").click();
      await $("button=Delete connection").click();
    }
  });

  it("saves Hosts and Capabilities heights across native restarts and resets them", async () => {
    await addConnection("Layout host");
    await openOfflineConnection("Layout host");
    await feature("Baselines");
    let divider = $("aria/Resize Hosts and Capabilities");
    const original = Number(await divider.getAttribute("aria-valuenow"));
    if (isMac) {
      await focusElement(await divider);
      await pressBoundaryKey("ArrowUp", true);
    } else await divider.dragAndDrop({ x: 0, y: -60 });
    const chosen = Number(await divider.getAttribute("aria-valuenow"));
    expect(chosen).toBeLessThan(original - 30);
    const saved = () => ipc<PersistedWorkspaceState>("get_workspace_state");
    await browser.waitUntil(async () => (await saved()).panelSizes?.["sidebar:hosts"] === chosen);
    await restartApp();
    divider = $("aria/Resize Hosts and Capabilities");
    await expect(divider).toHaveAttribute("aria-valuenow", String(chosen));
    await focusElement(await divider);
    await pressBoundaryKey("End");
    await browser.waitUntil(async () =>
      browser.execute(() => {
        const nav = document.querySelector<HTMLElement>(".workspace-navigation")!;
        return nav.scrollHeight > nav.clientHeight && nav.clientHeight >= 96;
      }),
    );
    await $("aria/Resize Connections panel").moveTo();
    await browser.saveScreenshot("test-results/desktop/layout-dividers.png");
    if (isMac) {
      await focusElement(await divider);
      await browser.keys("Enter");
    } else await divider.doubleClick();
    await browser.waitUntil(async () => !("sidebar:hosts" in ((await saved()).panelSizes ?? {})));
    await expect(divider).toHaveAttribute("aria-valuenow", String(original));
    await focusElement(await divider);
    await pressBoundaryKey("Home");
    await $("aria/Reset layout").click();
    await browser.waitUntil(async () => Object.keys((await saved()).panelSizes ?? {}).length === 0);
    await restartApp();
    divider = $("aria/Resize Hosts and Capabilities");
    await expect(divider).toHaveAttribute("aria-valuenow", String(original));
  });
});
