import "./isolation";
import { $, $$, browser, expect } from "@wdio/globals";
import {
  addConnection,
  connectionMenu,
  feature,
  ipc,
  openLocal,
  restartApp,
  runtime,
  terminalCommand,
} from "./helpers";
import type { HistoryEntry, ScratchpadNote, PersistedWorkspaceState } from "../src/types";

async function note(text: string) {
  await $("textarea[aria-label='Connection note']").setValue(text);
  await expect($(".scratchpad-save-state")).toHaveText("Saved locally");
}

describe("Local data in remote Workspaces", () => {
  it("isolates connection notes, shares the global note, and restores SQLite after restart", async () => {
    const first = await addConnection("First offline host");
    await addConnection("Second offline host");
    await $(".host-main*=First offline host").click();
    await feature("Scratchpad");
    await note("First connection note");
    await $("aria/Global note for all connections").click();
    await $("textarea[aria-label='Global note']").setValue("Shared global note");
    await expect($(".scratchpad-save-state")).toHaveText("Saved locally");
    await $(".host-main*=Second offline host").click();
    await feature("Scratchpad");
    await expect($("textarea[aria-label='Connection note']")).toHaveValue("");
    await note("Second connection note");
    await $("aria/Global note for all connections").click();
    await expect($("textarea[aria-label='Global note']")).toHaveValue("Shared global note");
    await restartApp();
    await $(".host-main*=First offline host").click();
    await feature("Scratchpad");
    await expect($("textarea[aria-label='Connection note']")).toHaveValue("First connection note");
    expect(
      (
        await ipc<ScratchpadNote>("get_scratchpad_note", {
          scope: "connection",
          ownerId: first.id,
          connectionId: first.id,
        })
      ).text,
    ).toBe("First connection note");
  });

  it("undoes clear, cancels note deletion and deletes only the selected connection's data", async () => {
    await addConnection("Note owner");
    await $(".host-main*=Note owner").click();
    await feature("Scratchpad");
    await note("Keep this note");
    await $("button=Clear text").click();
    await expect($("textarea[aria-label='Connection note']")).toHaveValue("");
    await $("button=Undo").click();
    await expect($("textarea[aria-label='Connection note']")).toHaveValue("Keep this note");
    await $("button=Delete note").click();
    await $("button=Cancel").click();
    await expect($("textarea[aria-label='Connection note']")).toHaveValue("Keep this note");
    await $("button=Delete note").click();
    await $("[role=dialog]").$("button=Delete note").click();
    await expect($("textarea[aria-label='Connection note']")).toHaveValue("");
  });

  it("reads, searches and clears real SQLite history without modifying remote Bash", async () => {
    const connection = await addConnection("History owner");
    await ipc("set_connection_history_enabled", { connectionId: connection.id, enabled: true });
    const input = {
      connectionId: connection.id,
      sessionId: "fixture-session",
      command: "printf HISTORY_FIXTURE",
      cwd: "/srv",
      startedAt: "2026-10-07T10:00:00Z",
      finishedAt: "2026-10-07T10:00:01Z",
      exitCode: 0,
      shell: "bash",
    };
    const entry = await ipc<HistoryEntry>("add_history_entry", { input });
    await $(".host-main*=History owner").click();
    await feature("History");
    await expect($("code=printf HISTORY_FIXTURE")).toBeDisplayed();
    await $("input[placeholder='Search commands']").setValue("missing");
    await expect($("code=printf HISTORY_FIXTURE")).not.toExist();
    await $("input[placeholder='Search commands']").setValue("HISTORY_FIXTURE");
    await expect($("code=printf HISTORY_FIXTURE")).toBeDisplayed();
    await expect($("aria/Paste into terminal")).toBeDisabled();
    await $("button=Clear saved history").click();
    await $("button=Cancel").click();
    expect(
      (
        await ipc<HistoryEntry[]>("get_history", {
          connectionId: connection.id,
          search: "",
          limit: 500,
        })
      )[0].id,
    ).toBe(entry.id);
    await $("button=Clear saved history").click();
    await $("button=Clear history").click();
    expect(
      await ipc("get_history", { connectionId: connection.id, search: "", limit: 500 }),
    ).toEqual([]);
  });

  it("deletes every Workspace of a connection and keeps an unrelated local terminal running", async () => {
    const deleted = await addConnection("Deleted host");
    await $(".host-main*=Deleted host").click();
    await $("button=New terminal").click();
    await $(".new-terminal-menu").$("button*=Deleted host").click();
    expect(await $$(".session-tab-main*=Deleted host")).toHaveLength(2);
    const existingSessions = (await runtime()).sessionIds;
    await openLocal();
    await terminalCommand("echo UNRELATED_READY", "UNRELATED_READY");
    const localSession = (await runtime()).sessionIds.find((id) => !existingSessions.includes(id));
    expect(localSession).toBeDefined();
    await connectionMenu("Deleted host");
    await $("aria/Delete connection").click();
    await $("button=Delete connection").click();
    await expect($(".host-main*=Deleted host")).not.toExist();
    await expect($(".session-tab-main=Deleted host")).not.toExist();
    await terminalCommand("echo UNRELATED_SURVIVED", "UNRELATED_SURVIVED");
    expect((await runtime()).sessionIds).toContain(localSession);
    await browser.waitUntil(
      async () =>
        !(await ipc<PersistedWorkspaceState>("get_workspace_state")).workspaces.some(
          (workspace) => workspace.connectionId === deleted.id,
        ),
    );
    await restartApp();
    await expect($(".host-main*=Deleted host")).not.toExist();
    await expect($(".session-tab-main*=Deleted host")).not.toExist();
    expect(
      (await ipc<PersistedWorkspaceState>("get_workspace_state")).workspaces.some(
        (workspace) => workspace.connectionId === deleted.id,
      ),
    ).toBe(false);
  });
});
