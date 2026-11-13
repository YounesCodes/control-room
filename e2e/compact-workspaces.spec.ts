import { localShellLabel } from "./platform";
import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import {
  openSplitMenu,
  focusElement,
  addConnection,
  ipc,
  openLocal,
  openOfflineConnection,
  runtime,
  terminalCommand,
  terminalContains,
  restartApp,
} from "./helpers";
import type { PersistedWorkspaceState } from "../src/types";

describe("Compact native windows and live terminal arrangements", () => {
  it("settles a side-by-side split without scrolling or wobbling", async () => {
    await browser.setWindowSize(1180, 700);
    await openLocal();
    await $("aria/Focus terminal").click();
    await openSplitMenu();
    await $(`.new-terminal-menu [aria-label='New local terminal: ${localShellLabel}']`).click();
    await terminalCommand("echo STABLE_SPLIT_INPUT", "STABLE_SPLIT_INPUT");
    const sessions = (await runtime()).sessionIds;
    expect(sessions).toHaveLength(2);
    await browser.waitUntil(() =>
      browser.execute(() => {
        const panes = Array.from(document.querySelectorAll(".terminal-workspace-pane-visible"));
        return panes.length === 2 && panes.every((pane) => pane.getAnimations().length === 0);
      }),
    );
    const frames = await browser.execute(async () => {
      const viewport = document.querySelector<HTMLElement>(".terminal-pane-layout")!;
      const panes = Array.from(viewport.querySelectorAll(".terminal-workspace-pane-visible"));
      const sizes = new Set<string>();
      for (let frame = 0; frame < 20; frame++) {
        await new Promise(requestAnimationFrame);
        if (
          viewport.clientWidth !== viewport.scrollWidth ||
          viewport.clientHeight !== viewport.scrollHeight
        )
          throw new Error(`Unexpected split scrollbars at ${devicePixelRatio}x display scale`);
        sizes.add(JSON.stringify(panes.map((pane) => pane.getBoundingClientRect().toJSON())));
      }
      return [...sizes];
    });
    expect(frames).toHaveLength(1);
    expect((await runtime()).sessionIds).toEqual(sessions);
  });

  it("resizes a borderless window through compact and full views without losing its session", async () => {
    await addConnection("Compact host with a long connection name");
    await openOfflineConnection("Compact host with a long connection name");
    await openLocal();
    await terminalCommand("echo COMPACT_SESSION_SURVIVES", "COMPACT_SESSION_SURVIVES");
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 1);
    const sessions = (await runtime()).sessionIds;
    for (const width of [520, 600, 683, 768, 960, 1180]) {
      await browser.setWindowSize(width, width <= 768 ? 480 : 600);
      await browser.waitUntil(async () =>
        browser.execute((expected) => Math.abs(innerWidth - expected) < 20, width),
      );
      const sizes = await browser.execute(() => ({
        width: innerWidth,
        height: innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      expect(sizes.overflow).toBe(false);
      if (width < 860) {
        await $("aria/Open navigation").click();
        await expect($("aria/Saved connections")).toBeDisplayed();
        await browser.keys("Escape");
        await expect($("aria/Open navigation")).toBeFocused();
      }
      await terminalCommand("echo SIZE_" + width, "SIZE_" + width);
      expect((await runtime()).sessionIds).toEqual(sessions);
      await browser.saveScreenshot(`test-results/desktop/compact-native-${width}.png`);
    }
    await $("aria/Maximize or restore window").click();
    await browser.waitUntil(() => ipc<boolean>("plugin:window|is_maximized", { label: "main" }));
    await $("aria/Maximize or restore window").click();
    await browser.waitUntil(
      async () => !(await ipc<boolean>("plugin:window|is_maximized", { label: "main" })),
    );
    await terminalContains("COMPACT_SESSION_SURVIVES");
    await browser.setWindowSize(600, 480);
    await $("aria/Open navigation").click();
    await $(".host-main").click();
    for (const view of ["Systemd", "Ports", "Docker", "Logs", "History"]) {
      await $("aria/Open navigation").click();
      await $("nav[aria-label='Workspace features']")
        .$("button=" + view)
        .click();
      await browser.waitUntil(() =>
        browser.execute(() => {
          const content = document.querySelector<HTMLElement>(".workspace-content");
          return (
            !!content &&
            content.scrollWidth <= content.clientWidth + 1 &&
            document.documentElement.scrollWidth <= innerWidth
          );
        }),
      );
      await browser.saveScreenshot(`test-results/desktop/compact-native-${view.toLowerCase()}.png`);
    }
  });

  it("swaps, docks, flips, resizes and restores nested panes through SQLite with live PTYs", async () => {
    await browser.setWindowSize(1180, 700);
    await openLocal();
    await terminalCommand("echo ARRANGEMENT_SCROLLBACK", "ARRANGEMENT_SCROLLBACK");
    await $("aria/Focus terminal").click();
    for (let index = 0; index < 2; index++) {
      await openSplitMenu();
      await $(`.new-terminal-menu [aria-label='New local terminal: ${localShellLabel}']`).click();
    }
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 3);
    const sessions = (await runtime()).sessionIds;
    const saved = () => ipc<PersistedWorkspaceState>("get_workspace_state");
    const arrange = async (action: string) => {
      await browser.waitUntil(() =>
        browser.execute(() =>
          Array.from(document.querySelectorAll(".terminal-pane-heading")).every((heading) =>
            heading.getAnimations().every((animation) => animation.playState !== "running"),
          ),
        ),
      );
      await $(`[aria-label='Arrange ${localShellLabel}']`).click();
      await $(".terminal-arrange-menu").waitForDisplayed();
      await $(".terminal-arrange-menu").$(`aria/${action}`).click();
    };
    await arrange(`Swap with ${localShellLabel} 2`);
    await arrange(`Dock below ${localShellLabel} 2`);
    await arrange("Side by side");
    const divider = $("aria/Resize terminal split 2");
    await focusElement(await divider);
    await browser.keys("ArrowRight");
    await browser.waitUntil(async () => {
      const layout = (await saved()).terminalGroups?.[0].layout;
      return (
        layout?.kind === "split" &&
        layout.first.kind === "split" &&
        layout.first.ratio !== undefined
      );
    });
    const layout = (await saved()).terminalGroups![0].layout;
    for (const width of [600, 1180]) {
      await browser.setWindowSize(width, 600);
      await browser.waitUntil(async () =>
        browser.execute(() =>
          Array.from(
            document.querySelectorAll<HTMLElement>(".terminal-workspace-pane-visible"),
          ).every((pane) => pane.offsetWidth >= 279 && pane.offsetHeight >= 179),
        ),
      );
      expect((await runtime()).sessionIds).toEqual(sessions);
      expect((await saved()).terminalGroups![0].layout).toEqual(layout);
    }
    await browser.saveScreenshot("test-results/desktop/terminal-arrangement-native.png");
    // Focus that pane's terminal body; its corner handle now opens Arrange on click.
    const commandPromptPane = await browser.execute(
      (shellLabel) =>
        document
          .querySelector(`[aria-label='Arrange ${shellLabel}']`)!
          .closest<HTMLElement>(".terminal-pane-heading")!
          .dataset.terminalMotionId!.replace(/-heading$/, ""),
      localShellLabel,
    );
    await $(`[data-workspace-id='${commandPromptPane}'] .xterm`).click();
    await terminalCommand("echo ARRANGEMENT_INPUT", "ARRANGEMENT_INPUT");
    await terminalContains("ARRANGEMENT_SCROLLBACK");
    await restartApp();
    expect((await saved()).terminalGroups![0].layout).toEqual(layout);
  });
});
