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
} from "./helpers";
import type { PersistedWorkspaceState } from "../src/types";

async function renameActive(name: string) {
  await $(".session-tab-wrap.active .session-tab-main").moveTo();
  await $(".session-tab-wrap.active .session-tab-rename").click();
  await $("[role=dialog] input").setValue(name);
  await $("button=Rename").click();
}

describe("ConPTY and Workspace lifecycle", () => {
  it("selects independent terminal groups and deletes a group while keeping its sessions", async () => {
    await openLocal();
    await $("aria/Focus terminal").click();
    for (const name of ["First group", "Second group"]) {
      if (name === "Second group") await openLocal();
      await $("aria/Split terminal").click();
      await $(".terminal-split-menu").$("button*=Command Prompt").click();
      await $(".session-tab-group.active button[title='Rename terminal group']").click();
      await $("[role=dialog] input").setValue(name);
      await $("button=Rename").click();
    }
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 4);
    await $("[aria-label='Open First group, 2 terminals']").click();
    await terminalCommand("echo FIRST_GROUP_OK", "FIRST_GROUP_OK");
    await $("[aria-label='Open Second group, 2 terminals']").click();
    await terminalCommand("echo SECOND_GROUP_OK", "SECOND_GROUP_OK");
    await $("[aria-label='Delete Second group; terminals stay open']").click();
    await expect($("[aria-label='Open Second group, 2 terminals']")).not.toExist();
    expect((await runtime()).sessionIds).toHaveLength(4);
    await terminalCommand("echo UNGROUPED_SURVIVOR", "UNGROUPED_SURVIVOR");
  });
  it("accepts Unicode and multiline input while another Workspace receives background output", async () => {
    await openLocal();
    await renameActive("Background shell");
    const initialSession = (await runtime()).sessionIds[0];
    await $(".terminal-workspace-pane.active .xterm-screen").click();
    await browser.keys("ping 127.0.0.1 -n 3 >nul & echo BACKGROUND_FINISHED");
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
    await $("aria/Close Command Prompt Workspace").click();
    await $("button=Cancel").click();
    await terminalCommand("echo AFTER_CANCEL_OK", "AFTER_CANCEL_OK");
    await closeWorkspace("Command Prompt");
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 0);
    await expect($(".xterm-screen")).not.toExist();
  });

  it("keeps a naturally exited Workspace and starts a fresh session on Restart", async () => {
    await openLocal();
    const initial = (await runtime()).sessionIds[0];
    await $(".terminal-workspace-pane.active .xterm-screen").click();
    await browser.keys("exit");
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
    await terminalCommand('set "CONTROL_ROOM_VALUE=FIRST" & echo FIRST_READY', "FIRST_READY");
    await openLocal();
    await renameActive("Second shell");
    await terminalCommand("echo SECOND_READY", "SECOND_READY");
    expect((await runtime()).sessionIds).toHaveLength(2);
    await $(".session-tab-main=First shell").click();
    await terminalCommand("echo %CONTROL_ROOM_VALUE%", "FIRST");
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
      await $(".terminal-split-menu").$("button*=Command Prompt").click();
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
      await $(".session-tab-group.active button[title='Rename terminal group']").click();
      await $("[role=dialog] input").setValue("Persistent pair");
      await $("button=Rename").click();
      await browser.waitUntil(
        async () =>
          (await ipc<PersistedWorkspaceState>("get_workspace_state")).terminalGroups?.[0]?.name ===
          "Persistent pair",
      );
      await restartApp();
      await $("aria/Focus terminal").click();
      await expect($(".session-tab-group-label*=Persistent pair")).toBeDisplayed();
      expect(
        await browser.execute(
          () => document.querySelectorAll(".terminal-workspace-pane-visible").length,
        ),
      ).toBe(2);
      await closeWorkspace("Command Prompt");
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
