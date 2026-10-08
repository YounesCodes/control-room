import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { addConnection, feature, ipc, restartApp } from "./helpers";
import type { PersistedWorkspaceState } from "../src/types";

describe("Resizable panels in the native app", () => {
  it("drags and saves the Connections width through SQLite and resets it", async () => {
    const divider = $("aria/Resize Connections panel");
    const defaultWidth = await divider.getAttribute("aria-valuenow");
    await divider.dragAndDrop({ x: 100, y: 0 });
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
    await $(".host-main*=Layout host A").click();
    const openBaselines = async () => {
      await $("nav[aria-label='Workspace features']").$("button=Baselines").click();
    };
    await openBaselines();
    let content = $("aria/Resize Baselines content");
    await content.click();
    await browser.keys("ArrowLeft");
    const contentWidth = Number(await content.getAttribute("aria-valuenow"));
    let split = $("aria/Resize Baselines panes");
    await split.click();
    await browser.keys(["Shift", "ArrowLeft", "NULL"]);
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
    await $(".host-main*=Layout host B").click();
    await openBaselines();
    await expect(split).toHaveAttribute("aria-valuenow", String(splitWidth));
    await restartApp();
    content = $("aria/Resize Baselines content");
    split = $("aria/Resize Baselines panes");
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
    await split.doubleClick();
    await browser.waitUntil(async () => !("split:Baselines" in (await saved()).panelSizes));
    await $("aria/Reset layout").click();
    await browser.waitUntil(async () => Object.keys((await saved()).panelSizes).length === 0);
    for (const name of ["Layout host A", "Layout host B"]) {
      const menu = $("aria/Open actions for " + name);
      await menu.moveTo();
      await menu.click();
      await $("aria/Delete connection").click();
      await $("button=Delete connection").click();
    }
  });

  it("saves Hosts and Capabilities heights across native restarts and resets them", async () => {
    await addConnection("Layout host");
    await $(".host-main*=Layout host").click();
    await feature("Baselines");
    let divider = $("aria/Resize Hosts and Capabilities");
    const original = Number(await divider.getAttribute("aria-valuenow"));
    await divider.dragAndDrop({ x: 0, y: -60 });
    const chosen = Number(await divider.getAttribute("aria-valuenow"));
    expect(chosen).toBeLessThan(original - 30);
    const saved = () => ipc<PersistedWorkspaceState>("get_workspace_state");
    await browser.waitUntil(async () => (await saved()).panelSizes?.["sidebar:hosts"] === chosen);
    await restartApp();
    divider = $("aria/Resize Hosts and Capabilities");
    await expect(divider).toHaveAttribute("aria-valuenow", String(chosen));
    await divider.click();
    await browser.keys("End");
    await browser.waitUntil(async () =>
      browser.execute(() => {
        const nav = document.querySelector<HTMLElement>(".workspace-navigation")!;
        return nav.scrollHeight > nav.clientHeight && nav.clientHeight >= 96;
      }),
    );
    await $("aria/Resize Connections panel").moveTo();
    await browser.saveScreenshot("test-results/desktop/layout-dividers.png");
    await divider.doubleClick();
    await browser.waitUntil(async () => !("sidebar:hosts" in ((await saved()).panelSizes ?? {})));
    await expect(divider).toHaveAttribute("aria-valuenow", String(original));
    await divider.click();
    await browser.keys("Home");
    await $("aria/Reset layout").click();
    await browser.waitUntil(async () => Object.keys((await saved()).panelSizes ?? {}).length === 0);
    await restartApp();
    divider = $("aria/Resize Hosts and Capabilities");
    await expect(divider).toHaveAttribute("aria-valuenow", String(original));
  });
});
