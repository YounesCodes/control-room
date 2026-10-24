import { isMac, localShellLabel } from "./platform";
import "./isolation";
import { $, $$, browser, expect } from "@wdio/globals";
import {
  closeWorkspace,
  ipc,
  openLocal,
  restartApp,
  runtime,
  terminalCommand,
  terminalContains,
  typeTerminalText,
  focusElement,
  pressBoundaryKey,
  activateFocusedButton,
} from "./helpers";
import type { PersistedWorkspaceState } from "../src/types";

async function renameActive(name: string) {
  // Focus keeps tab actions revealed if native hover changes during reflow.
  await $(".session-tab-wrap.active .session-tab-main").click();
  const rename = $(".session-tab-wrap.active .session-tab-rename");
  await rename.moveTo();
  await rename.waitForClickable();
  await rename.click();
  await $("[role=dialog] input").setValue(name);
  await $("button=Rename").click();
}

describe("Native PTY and Workspace lifecycle", () => {
  it("selects hidden terminals from overflow without clipping tabs or restarting sessions", async () => {
    for (let index = 1; index <= 8; index++) {
      await openLocal();
      await renameActive(`Shell ${index}`);
    }
    await $("aria/Focus terminal").click();
    const sessions = (await runtime()).sessionIds;
    await $("[aria-label='All terminals']").click();
    await $("[role=menu]").$("button*=Shell 1").click();
    await expect($(".session-tab-wrap.active .session-tab-main")).toHaveText("Shell 1");
    await terminalCommand("echo OVERFLOW_FIRST", "OVERFLOW_FIRST");
    await $("[aria-label='Scroll terminals right']").click();
    await $("[aria-label='All terminals']").click();
    await pressBoundaryKey("Home");
    await activateFocusedButton();
    await expect($(".session-tab-wrap.active .session-tab-main")).toHaveText("Shell 1");
    await $("[aria-label='All terminals']").click();
    await pressBoundaryKey("End");
    await activateFocusedButton();
    await expect($(".session-tab-wrap.active .session-tab-main")).toHaveText("Shell 8");
    await terminalCommand("echo OVERFLOW_LAST", "OVERFLOW_LAST");
    const clipped = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".session-tab-list")).flatMap((list) => {
        const bounds = list.getBoundingClientRect();
        return Array.from(
          list.querySelectorAll<HTMLElement>(".session-tab-wrap, .session-tab-group"),
        )
          .filter((tab) => {
            const rect = tab.getBoundingClientRect();
            return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
          })
          .map((tab) => tab.textContent);
      }),
    );
    expect(clipped).toEqual([]);
    expect((await runtime()).sessionIds).toEqual(sessions);
    await closeWorkspace("Shell 8");
    await expect($(".session-tab-wrap.active .session-tab-main")).toHaveText("Shell 7");
    expect((await runtime()).sessionIds).toHaveLength(7);
  });

  it("renames and closes specific split panes, cancels group actions, and restores the survivors", async () => {
    await openLocal();
    await renameActive("Original pane");
    await $("aria/Focus terminal").click();
    for (const name of ["Logs pane", "Build pane"]) {
      await $("aria/Split terminal").click();
      await $(".terminal-split-menu").$(`button*=${localShellLabel}`).click();
      await renameActive(name);
    }
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 3);
    const sessions = (await runtime()).sessionIds;
    await $("[aria-label='Rename Logs pane Workspace']").click();
    await $("[role=dialog] input").setValue("Renamed logs");
    await $("button=Rename").click();
    await expect($("[aria-label='Close Renamed logs Workspace']")).toExist();
    await expect($(".session-pane-tabs .session-tab-wrap.active .session-tab-main")).toHaveText(
      "Build pane",
    );
    await $("[aria-label^='Ungroup ']").click();
    await $("button=Cancel").click();
    expect((await runtime()).sessionIds).toEqual(sessions);
    await $("[aria-label='Close Renamed logs Workspace']").click();
    await $("button=Cancel").click();
    expect((await runtime()).sessionIds).toEqual(sessions);
    await $("[aria-label='Close Renamed logs Workspace']").click();
    await $("button=Stop & close").click();
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 2);
    await expect($(".session-tab-group-main small")).toHaveText("2");
    await expect($(".session-pane-tabs .session-tab-wrap.active .session-tab-main")).toHaveText(
      "Build pane",
    );
    await terminalCommand("echo BUILD_SURVIVES", "BUILD_SURVIVES");
    await browser.waitUntil(async () => {
      const saved = await ipc<PersistedWorkspaceState>("get_workspace_state");
      return (
        saved.workspaces.length === 2 &&
        saved.workspaces.some((workspace) => workspace.label === "Build pane")
      );
    });
    await restartApp(true);
    await $("aria/Focus terminal").click();
    await expect($("[aria-label='Close Original pane Workspace']")).toExist();
    await expect($("[aria-label='Close Build pane Workspace']")).toExist();
    await closeWorkspace("Build pane");
    await expect($(".session-pane-tabs")).not.toExist();
    await expect($(".session-tab-wrap.active .session-tab-main")).toHaveText("Original pane");
    await terminalCommand("echo ORIGINAL_SURVIVES", "ORIGINAL_SURVIVES");
    await closeWorkspace("Original pane");
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 0);
    await expect($("[aria-label='Exit terminal focus']")).not.toExist();
  });

  it("dispatches permitted native dragging from the Focus Mode top strip", async () => {
    await openLocal();
    await $("aria/Focus terminal").click();
    // WebDriver input is confined to WebView2. Observe the real native call
    // and its result rather than treating synthetic motion as OS movement.
    await browser.execute(() => {
      const probeWindow = window as unknown as {
        __TAURI_INTERNALS__: { convertFileSrc: (command: string, protocol: string) => string };
        __dragProbe: {
          original: typeof fetch;
          calls: { complete: boolean; error: string | null }[];
        };
      };
      const original = window.fetch;
      const dragUrl = probeWindow.__TAURI_INTERNALS__.convertFileSrc(
        "plugin:window|start_dragging",
        "ipc",
      );
      probeWindow.__dragProbe = { original, calls: [] };
      window.fetch = async (input, options) => {
        if (String(input) !== dragUrl) return original(input, options);
        const call = { complete: false, error: null as string | null };
        probeWindow.__dragProbe.calls.push(call);
        try {
          const response = await original(input, options);
          if (response.headers.get("Tauri-Response") !== "ok")
            call.error = await response.clone().text();
          return response;
        } catch (error) {
          call.error = String(error);
          throw error;
        } finally {
          call.complete = true;
        }
      };
    });
    const calls = () =>
      browser.execute(
        () =>
          (
            window as unknown as {
              __dragProbe: { calls: { complete: boolean; error: string | null }[] };
            }
          ).__dragProbe.calls,
      );
    try {
      await $(".session-tab-wrap.active .session-tab-main").click();
      expect(await calls()).toEqual([]);
      if (isMac)
        await browser.execute(() =>
          document
            .querySelector(".session-window-drag-region")!
            .dispatchEvent(
              new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 1, detail: 1 }),
            ),
        );
      else await $(".session-window-drag-region").click();
      await browser.waitUntil(async () => (await calls())[0]?.complete === true);
      expect(await calls()).toEqual([{ complete: true, error: null }]);
    } finally {
      await browser.execute(() => {
        const probeWindow = window as unknown as {
          __dragProbe?: { original: typeof fetch };
        };
        window.fetch = probeWindow.__dragProbe!.original;
        delete probeWindow.__dragProbe;
      });
    }
    await terminalCommand("echo DRAG_PRESERVED_SESSION", "DRAG_PRESERVED_SESSION");
  });
  it("selects independent terminal groups and ungroups one while keeping its sessions", async () => {
    await openLocal();
    await $("aria/Focus terminal").click();
    for (const name of ["First group", "Second group"]) {
      if (name === "Second group") await openLocal();
      await $("aria/Split terminal").click();
      await $(".terminal-split-menu").$(`button*=${localShellLabel}`).click();
      await $(".session-pane-tabs button[title='Rename terminal group']").click();
      await $("[role=dialog] input").setValue(name);
      await $("button=Rename").click();
    }
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 4);
    await $("[aria-label='Open First group 2 terminals']").click();
    await terminalCommand("echo FIRST_GROUP_OK", "FIRST_GROUP_OK");
    await $("[aria-label='Open Second group 2 terminals']").click();
    await terminalCommand("echo SECOND_GROUP_OK", "SECOND_GROUP_OK");
    await $("[aria-label='Ungroup Second group; terminals stay open']").click();
    await $("[role=dialog]").$("button=Ungroup").click();
    await expect($("[aria-label='Open Second group 2 terminals']")).not.toExist();
    expect((await runtime()).sessionIds).toHaveLength(4);
    await terminalCommand("echo UNGROUPED_SURVIVOR", "UNGROUPED_SURVIVOR");
  });
  it("accepts Unicode and multiline input while another Workspace receives background output", async () => {
    await openLocal();
    await renameActive("Background shell");
    const initialSession = (await runtime()).sessionIds[0];
    await $(".terminal-workspace-pane.active .xterm-screen").click();
    await typeTerminalText(
      isMac
        ? "sleep 2; echo BACKGROUND_FINISHED"
        : "ping 127.0.0.1 -n 3 >nul & echo BACKGROUND_FINISHED",
    );
    await browser.keys("Enter");
    await openLocal();
    await renameActive("Unicode shell");
    await terminalCommand("echo 日本語-é", "日本語-é");
    const sessions = await runtime();
    const activeSession = sessions.sessionIds.find((id) => id !== initialSession)!;
    await ipc("write_session", {
      sessionId: activeSession,
      data: Array.from(
        new TextEncoder().encode("echo MULTILINE_FIRST\r\necho MULTILINE_SECOND\r\n"),
      ),
    });
    await terminalContains("MULTILINE_FIRST");
    await terminalContains("MULTILINE_SECOND");
    await $(".session-tab-main=Background shell").click();
    await terminalContains("BACKGROUND_FINISHED");
  });
  it("prints output, cancels close, and then proves the native session exited", async () => {
    await openLocal();
    await terminalCommand("echo CONTROL_ROOM_E2E_OK", "CONTROL_ROOM_E2E_OK");
    await $(".session-tab-wrap.active .session-tab-main").moveTo();
    await $(`aria/Close ${localShellLabel} Workspace`).click();
    await $("button=Cancel").click();
    await terminalCommand("echo AFTER_CANCEL_OK", "AFTER_CANCEL_OK");
    await closeWorkspace(localShellLabel);
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 0);
    await expect($(".xterm-screen")).not.toExist();
  });

  it("keeps a naturally exited Workspace and starts a fresh session on Restart", async () => {
    await openLocal();
    const initial = (await runtime()).sessionIds[0];
    await $(".terminal-workspace-pane.active .xterm-screen").click();
    await typeTerminalText("exit");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 0);
    await expect($(".session-tab-wrap.active")).toBeDisplayed();
    await $("aria/Restart terminal").click();
    await terminalCommand("echo RESTARTED_OK", "RESTARTED_OK");
    expect((await runtime()).sessionIds[0]).not.toBe(initial);
  });

  it("routes input to independent Workspaces and closes only the selected session", async () => {
    await openLocal();
    await renameActive("First shell");
    await terminalCommand(
      isMac
        ? "export CONTROL_ROOM_VALUE=FIRST; echo FIRST_READY"
        : 'set "CONTROL_ROOM_VALUE=FIRST" & echo FIRST_READY',
      "FIRST_READY",
    );
    await openLocal();
    await renameActive("Second shell");
    await terminalCommand("echo SECOND_READY", "SECOND_READY");
    expect((await runtime()).sessionIds).toHaveLength(2);
    await $(".session-tab-main=First shell").click();
    await terminalCommand(
      isMac ? "echo $CONTROL_ROOM_VALUE" : "echo %CONTROL_ROOM_VALUE%",
      "FIRST",
    );
    await closeWorkspace("First shell");
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 1);
    await terminalCommand("echo SURVIVOR_OK", "SURVIVOR_OK");
  });

  it("restores labels and fresh sessions without restoring old terminal output", async () => {
    await openLocal();
    await renameActive("Persistent shell");
    await terminalCommand("echo OLD_PROCESS_ONLY", "OLD_PROCESS_ONLY");
    const initial = (await runtime()).sessionIds;
    await browser.waitUntil(
      async () =>
        (await ipc<PersistedWorkspaceState>("get_workspace_state")).workspaces[0]?.label ===
        "Persistent shell",
    );
    await restartApp();
    await expect($(".session-tab-main=Persistent shell")).toBeDisplayed();
    await terminalCommand("echo FRESH_PROCESS_OK", "FRESH_PROCESS_OK");
    expect((await runtime()).sessionIds).not.toEqual(initial);
    const text = await browser.execute(
      () => document.querySelector(".terminal-workspace-pane.active .xterm-rows")?.textContent,
    );
    expect(text).not.toContain("OLD_PROCESS_ONLY");
  });

  it("finds real terminal output and returns focus when search closes", async () => {
    await openLocal();
    await terminalCommand("echo UNIQUE_SEARCH_NEEDLE", "UNIQUE_SEARCH_NEEDLE");
    await $("aria/Find in terminal").click();
    await $("aria/Find in terminal output").setValue("UNIQUE_SEARCH_NEEDLE");
    await expect($(".terminal-search")).toHaveText(expect.stringContaining("of"));
    await $("aria/Close terminal search").click();
    await expect($("aria/Find in terminal output")).not.toExist();
    await terminalCommand("echo SEARCH_CLOSED_OK", "SEARCH_CLOSED_OK");
  });

  for (const direction of ["vertically", "horizontally"]) {
    it(`splits ${direction}, routes input, renames the group and restores its layout`, async () => {
      await openLocal();
      await $("aria/Focus terminal").click();
      await $("aria/Split terminal").click();
      await $(`button*=Split ${direction}`).click();
      await $(".terminal-split-menu").$(`button*=${localShellLabel}`).click();
      await browser.waitUntil(async () => (await runtime()).sessionIds.length === 2);
      const panes = await browser.execute(() =>
        Array.from(document.querySelectorAll(".terminal-workspace-pane-visible"), (pane) => {
          const bounds = pane.getBoundingClientRect();
          return { left: bounds.left, top: bounds.top };
        }),
      );
      expect(panes).toHaveLength(2);
      if (direction === "vertically") expect(panes[0].left).not.toBe(panes[1].left);
      else expect(panes[0].top).not.toBe(panes[1].top);
      const divider = $("aria/Resize terminal split 1");
      const beforeResize = Number(await divider.getAttribute("aria-valuenow"));
      const sessionIds = (await runtime()).sessionIds;
      await focusElement(await divider);
      await pressBoundaryKey(direction === "vertically" ? "ArrowRight" : "ArrowDown", true);
      await browser.waitUntil(
        async () => Number(await divider.getAttribute("aria-valuenow")) > beforeResize + 40,
      );
      expect((await runtime()).sessionIds).toEqual(sessionIds);
      await terminalCommand("echo ACTIVE_PANE_OK", "ACTIVE_PANE_OK");
      const terminals = await $$(".terminal-workspace-pane-visible .xterm-screen");
      await terminals[0].click();
      await terminalCommand("echo FIRST_PANE_ONLY", "FIRST_PANE_ONLY");
      await terminals[1].click();
      await terminalCommand("echo SECOND_PANE_ONLY", "SECOND_PANE_ONLY");
      const printed = await browser.execute(() =>
        Array.from(
          document.querySelectorAll(".terminal-workspace-pane-visible .xterm-rows"),
          (rows) => rows.textContent,
        ),
      );
      expect(printed[0]).not.toContain("SECOND_PANE_ONLY");
      expect(printed[1]).not.toContain("FIRST_PANE_ONLY");
      await $(".session-pane-tabs button[title='Rename terminal group']").click();
      await $("[role=dialog] input").setValue("Persistent pair");
      await $("button=Rename").click();
      await browser.waitUntil(
        async () =>
          (await ipc<PersistedWorkspaceState>("get_workspace_state")).terminalGroups?.[0]?.name ===
          "Persistent pair",
      );
      const savedLayout = (await ipc<PersistedWorkspaceState>("get_workspace_state"))
        .terminalGroups![0].layout;
      expect(savedLayout.kind).toBe("split");
      if (savedLayout.kind === "split") expect(savedLayout.ratio).toBeGreaterThan(0.5);
      await restartApp();
      await $("aria/Focus terminal").click();
      await expect($(".session-tab-group-label*=Persistent pair")).toBeDisplayed();
      expect(
        (await ipc<PersistedWorkspaceState>("get_workspace_state")).terminalGroups![0].layout,
      ).toEqual(savedLayout);
      await expect($("aria/Resize terminal split 1")).toBeDisplayed();
      expect(
        await browser.execute(
          () => document.querySelectorAll(".terminal-workspace-pane-visible").length,
        ),
      ).toBe(2);
      await closeWorkspace(localShellLabel);
      await browser.waitUntil(async () => (await runtime()).sessionIds.length === 1);
      await expect($(".session-tab-group")).not.toExist();
      await browser.waitUntil(
        async () =>
          (await ipc<PersistedWorkspaceState>("get_workspace_state")).terminalGroups?.length === 0,
      );
      await $("aria/Exit terminal focus").click();
      await expect($(".session-tab-group")).not.toExist();
      expect((await runtime()).sessionIds).toHaveLength(1);
    });
  }
});
