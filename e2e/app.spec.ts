import { $, browser, expect } from "@wdio/globals";

describe("Control Room desktop", () => {
  it("launches with real backend data and opens and closes Settings", async () => {
    await expect($("aria/Saved connections")).toBeDisplayed();
    await $("aria/Open Settings").click();
    await expect($("h2=Settings")).toBeDisplayed();
    await $("aria/Close Settings").click();
    await expect($("h2=Settings")).not.toExist();
  });

  it("saves a setting through Rust and restores it after a webview reload", async () => {
    await $("aria/Open Settings").click();
    const family = $("//label[span[normalize-space()='Font family']]/input");
    const original = await family.getValue();
    const changed = original === "Consolas" ? "Courier New" : "Consolas";
    await family.setValue(changed);
    await $("button=Save settings").click();
    await expect($("[role=status]")).toHaveText("Settings saved.");
    await browser.refresh();
    await $("aria/Open Settings").click();
    await expect($("//label[span[normalize-space()='Font family']]/input")).toHaveValue(changed);
    await $("//label[span[normalize-space()='Font family']]/input").setValue(original);
    await $("button=Save settings").click();
    await $("aria/Close Settings").click();
  });

  it("drags and saves the Connections width through SQLite and resets it", async () => {
    const divider = $("aria/Resize Connections panel");
    await divider.dragAndDrop({ x: 100, y: 0 });
    const chosen = Number(await divider.getAttribute("aria-valuenow"));
    expect(chosen).toBeGreaterThan(300);
    await browser.waitUntil(async () => {
      const state = (await browser.tauri.execute(({ core }) =>
        core.invoke("get_workspace_state"),
      )) as { panelSizes: Record<string, number> };
      return state.panelSizes.connections === chosen;
    });
    await browser.refresh();
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
    await browser.refresh();
    await expect($("aria/Resize Connections panel")).toHaveAttribute("aria-valuenow", "244");
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
    const content = $("aria/Resize Baselines content");
    await content.click();
    await browser.keys("ArrowLeft");
    const contentWidth = Number(await content.getAttribute("aria-valuenow"));
    const split = $("aria/Resize Baselines panes");
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
    await browser.refresh();
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

  it("creates, edits, and deletes a Saved Connection in SQLite", async () => {
    await $(".sidebar-primary").click();
    await $("aria/Display name").setValue("E2E fixture");
    await $("aria/SSH destination").setValue("example.invalid");
    await $("aria/Username").setValue("tester");
    await $(".modal-actions button[type=submit]").click();
    await expect($(".host-main*=E2E fixture")).toBeDisplayed();

    const rowHeight = await browser.execute(
      () => document.querySelector(".host-row")!.getBoundingClientRect().height,
    );
    const fixtureMenu = $("aria/Open actions for E2E fixture");
    await fixtureMenu.moveTo();
    await fixtureMenu.click();
    await expect($(".host-context-menu")).toBeDisplayed();
    const openRowHeight = await browser.execute(
      () => document.querySelector(".host-row")!.getBoundingClientRect().height,
    );
    expect(openRowHeight).toBe(rowHeight);
    await $("aria/Edit connection").click();
    await $("aria/Display name").setValue("E2E renamed");
    await $(".modal-actions button[type=submit]").click();
    await expect($(".host-main*=E2E renamed")).toBeDisplayed();

    const renamedMenu = $("aria/Open actions for E2E renamed");
    await renamedMenu.moveTo();
    await renamedMenu.click();
    await $("aria/Delete connection").click();
    await expect($("[role=dialog]")).toBeDisplayed();
    await $("button=Delete connection").click();
    await expect($(".host-main*=E2E renamed")).not.toExist();
  });

  it("returns a registered Rust command error through the webview IPC", async () => {
    const result = await browser.executeAsync((done) => {
      const tauri = window as typeof window & {
        __TAURI_INTERNALS__: { invoke: (command: string, args: object) => Promise<unknown> };
      };
      tauri.__TAURI_INTERNALS__.invoke("delete_connection", { id: "missing-connection-id" }).then(
        () => done("unexpected success"),
        (error: unknown) => done(String(error)),
      );
    });
    expect(result).toContain("Saved Connection not found");
  });

  it("starts and closes a local terminal through ConPTY", async () => {
    await $("button=Local terminal").click();
    await $("aria/Command Prompt").click();
    await expect($(".terminal-container .xterm-screen")).toBeDisplayed();
    await expect($("aria/Open Workspaces")).toBeDisplayed();
    const screen = $(".terminal-container .xterm-screen");
    await screen.click();
    await browser.keys("echo CONTROL_ROOM_E2E_OK");
    await browser.keys("Enter");
    await browser.waitUntil(
      async () => {
        const lines = await browser.execute(() =>
          Array.from(document.querySelectorAll(".terminal-container .xterm-rows > div"), (row) =>
            row.textContent?.trim(),
          ),
        );
        return lines.includes("CONTROL_ROOM_E2E_OK");
      },
      { timeoutMsg: "Command Prompt did not print CONTROL_ROOM_E2E_OK through ConPTY" },
    );
    await $(".session-tab-wrap.active .session-tab-main").moveTo();
    await $("aria/Close Command Prompt Workspace").click();
    await expect($("[role=dialog]")).toBeDisplayed();
    await $("button=Stop & close").click();
    await expect($(".terminal-container .xterm-screen")).not.toExist();
  });

  it("changes the native window state and size when maximized", async () => {
    const isMaximized = async () =>
      (await browser.tauri.execute(({ core }) =>
        core.invoke("plugin:window|is_maximized", { label: "main" }),
      )) === true;
    const before = await browser.getWindowRect();
    expect(await isMaximized()).toBe(false);
    await $("aria/Maximize or restore window").click();
    await browser.waitUntil(async () => isMaximized(), {
      timeoutMsg: "The native window did not enter the maximized state",
    });
    const maximized = await browser.getWindowRect();
    expect(maximized.width).toBeGreaterThan(before.width);
    expect(maximized.height).toBeGreaterThan(before.height);
    await $("aria/Maximize or restore window").click();
    await browser.waitUntil(async () => !(await isMaximized()), {
      timeoutMsg: "The native window did not leave the maximized state",
    });
    const restored = await browser.getWindowRect();
    expect(Math.abs(restored.width - before.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(restored.height - before.height)).toBeLessThanOrEqual(2);
  });
});
