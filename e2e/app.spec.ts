import { $, browser, expect } from "@wdio/globals";

describe("Control Room desktop", () => {
  it("launches with real backend data and opens and closes Settings", async () => {
    await expect($("aria/Saved connections")).toBeDisplayed();
    await $("aria/Open Settings").click();
    await expect($("h2=Settings")).toBeDisplayed();
    await $("aria/Back to terminal").click();
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
    await $("aria/Back to terminal").click();
  });

  it("creates, edits, and deletes a Saved Connection in SQLite", async () => {
    await $(".sidebar-primary").click();
    await $("aria/Display name").setValue("E2E fixture");
    await $("aria/SSH destination").setValue("example.invalid");
    await $("aria/Username").setValue("tester");
    await $(".modal-actions button[type=submit]").click();
    await expect($(".host-main*=E2E fixture")).toBeDisplayed();

    const fixtureMenu = $("aria/Open actions for E2E fixture");
    await fixtureMenu.moveTo();
    await fixtureMenu.click();
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
    await $("aria/Close Command Prompt Workspace").click();
    await expect($("[role=dialog]")).toBeDisplayed();
    await $("button=Stop & close").click();
    await expect($(".terminal-container .xterm-screen")).not.toExist();
  });

  it("uses the permitted native maximize control", async () => {
    await $("aria/Maximize or restore window").click();
    await expect($("aria/Open Settings")).toBeDisplayed();
    await $("aria/Maximize or restore window").click();
  });
});
