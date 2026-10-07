import "./isolation";
import { $, expect } from "@wdio/globals";
import { addConnection, connectionMenu, ipc, restartApp } from "./helpers";
import type { ConnectionGroup, SavedConnection } from "../src/types";

describe("Saved Connections through real SQLite", () => {
  it("validates required fields and cancels without writing a connection", async () => {
    await $(".sidebar-primary").click();
    await $(".modal-actions button[type=submit]").click();
    await expect($(".inline-error")).toBeDisplayed();
    expect(await ipc("list_connections")).toEqual([]);
    await $("button=Cancel").click();
    await expect($("[role=dialog]")).not.toExist();
    expect(await ipc("list_connections")).toEqual([]);
  });

  it("creates, edits, searches, persists and deletes a connection, with cancellation", async () => {
    const saved = await addConnection("Desktop fixture");
    await connectionMenu("Desktop fixture");
    await $("aria/Edit connection").click();
    await $("aria/Display name").setValue("Discarded name");
    await $("button=Cancel").click();
    await expect($(".host-main*=Desktop fixture")).toBeDisplayed();
    await connectionMenu("Desktop fixture");
    await $("aria/Edit connection").click();
    await $("aria/Display name").setValue("Renamed fixture");
    await $("button=Save changes").click();
    await restartApp();
    await expect($(".host-main*=Renamed fixture")).toBeDisplayed();
    expect((await ipc<SavedConnection[]>("list_connections"))[0].id).toBe(saved.id);
    const search = $("aria/Filter connections by name, group, or tag");
    await search.setValue("missing");
    await expect($(".host-main")).not.toExist();
    await search.setValue("Renamed");
    await expect($(".host-main*=Renamed fixture")).toBeDisplayed();
    await connectionMenu("Renamed fixture");
    await $("aria/Delete connection").click();
    await $("button=Cancel").click();
    expect(await ipc<SavedConnection[]>("list_connections")).toHaveLength(1);
    await connectionMenu("Renamed fixture");
    await $("aria/Delete connection").click();
    await $("button=Delete connection").click();
    await expect($(".host-main")).not.toExist();
    await restartApp();
    expect(await ipc("list_connections")).toEqual([]);
  });

  it("organizes connections with groups and tags and preserves members when a group is deleted", async () => {
    await $("aria/Manage groups and tags").click();
    const groupInput = $("//label[span[normalize-space()='New group']]/input");
    await groupInput.setValue("Production");
    await $("button=Add group").click();
    await expect($("aria/Rename Production")).toBeDisplayed();
    await groupInput.setValue("Lab");
    await $("button=Add group").click();
    await $("aria/Move Lab up").click();
    await $("//label[span[normalize-space()='New tag']]/input").setValue("database");
    await $("button=Add tag").click();
    await expect($("aria/Rename database")).toBeDisplayed();
    await $("[role=dialog]").$("[aria-label='Close']").click();
    await addConnection("Grouped fixture");
    await connectionMenu("Grouped fixture");
    await $("aria/Edit connection").click();
    await $("//label[span[normalize-space()='Group']]/select").selectByVisibleText("Production");
    await $("[aria-label='Available tags']").$("button=database").click();
    await $("button=Save changes").click();
    await restartApp();
    const groups = await ipc<ConnectionGroup[]>("list_connection_groups");
    expect(groups.map((group) => group.name)).toEqual(["Lab", "Production"]);
    expect(
      (await ipc<SavedConnection[]>("list_connections"))[0].tags.map((tag) => tag.name),
    ).toEqual(["database"]);
    await $("aria/Filter connections by name, group, or tag").setValue("database");
    await expect($(".host-main*=Grouped fixture")).toBeDisplayed();
    await $("aria/Filter connections by name, group, or tag").setValue(" ");
    await $(".connection-group-heading*=Production").click();
    await expect($(".host-main*=Grouped fixture")).not.toExist();
    await restartApp();
    expect(
      (await ipc<ConnectionGroup[]>("list_connection_groups")).find(
        (group) => group.name === "Production",
      )?.collapsed,
    ).toBe(true);
    await $("aria/Manage groups and tags").click();
    await $("aria/Delete Production").click();
    await $("button=Delete group").click();
    await $("[role=dialog]").$("[aria-label='Close']").click();
    await expect($(".host-main*=Grouped fixture")).toBeDisplayed();
    expect((await ipc<SavedConnection[]>("list_connections"))[0].groupId).toBeNull();
  });

  it("reports invalid IDs and rejects unsafe destinations through registered IPC", async () => {
    await expect(ipc("delete_connection", { id: "missing" })).rejects.toThrow(
      "Saved Connection not found",
    );
    await expect(
      ipc("create_connection", {
        input: {
          displayName: "Unsafe",
          destination: "-oProxyCommand=echo",
          username: "tester",
          port: null,
          identityFile: null,
          historyEnabled: false,
          sudoEnabled: false,
          groupId: null,
          tagIds: [],
        },
      }),
    ).rejects.toThrow(/destination|unsafe|invalid/i);
    expect(await ipc("list_connections")).toEqual([]);
  });
});
