import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { openLocal, restartApp, savedSettings, terminalCommand } from "./helpers";

const font = () => $("//label[span[normalize-space()='Font family']]/input");

describe("Settings and native window", () => {
  it("saves terminal settings and restores them after a native app restart", async () => {
    expect((await savedSettings()).automaticUpdateChecks).toBe(false);
    await $("aria/Open Settings").click();
    await font().setValue("Courier New");
    await $("button=Save settings").click();
    await expect($("[role=status]")).toHaveText("Settings saved.");
    await restartApp();
    await $("aria/Open Settings").click();
    await expect(font()).toHaveValue("Courier New");
    await $("aria/Close Settings").click();
    await openLocal();
    await terminalCommand("echo SETTINGS_TERMINAL_OK", "SETTINGS_TERMINAL_OK");
  });

  it("keeps dirty settings on cancellation and discards them only on confirmation", async () => {
    const original = (await savedSettings()).terminalFontFamily;
    await $("aria/Open Settings").click();
    await font().setValue("Discard this draft");
    await $("aria/Close Settings").click();
    await expect($("h2=Discard changes?")).toBeDisplayed();
    await $("button=Cancel").click();
    await expect(font()).toHaveValue("Discard this draft");
    await $("aria/Close Settings").click();
    await $("button=Discard").click();
    await $("aria/Open Settings").click();
    await expect(font()).toHaveValue(original);
  });

  it("hides and restores Command Prompt in the launcher without uninstalling it", async () => {
    await $("aria/Open Settings").click();
    await $("//label[input[@type='checkbox']][contains(.,'Command Prompt')]/input").click();
    await $("button=Save settings").click();
    await $("aria/Close Settings").click();
    await $("button=Local terminal").click();
    await expect($("aria/Command Prompt")).not.toExist();
    await browser.keys("Escape");
    await restartApp();
    await $("aria/Open Settings").click();
    await $("button=Show all").click();
    await $("button=Save settings").click();
    await $("aria/Close Settings").click();
    await openLocal();
    await terminalCommand("echo RESTORED_SHELL_OK", "RESTORED_SHELL_OK");
  });

  it("maximizes and restores actual native dimensions", async () => {
    const maximized = () =>
      browser.tauri.execute(({ core }) =>
        core.invoke("plugin:window|is_maximized", { label: "main" }),
      );
    const before = await browser.getWindowRect();
    await $("aria/Maximize or restore window").click();
    await browser.waitUntil(async () => (await maximized()) === true);
    const expanded = await browser.getWindowRect();
    expect(expanded.width).toBeGreaterThan(before.width);
    expect(expanded.height).toBeGreaterThan(before.height);
    await $("aria/Maximize or restore window").click();
    await browser.waitUntil(async () => (await maximized()) === false);
    const restored = await browser.getWindowRect();
    expect(restored.width).toBe(before.width);
    expect(restored.height).toBe(before.height);
  });
});
