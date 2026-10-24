import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { ipc, openLocal, terminalCommand } from "./helpers";
import { isMac, localShellId } from "./platform";
import type { EnvironmentInfo, LocalShellCatalog } from "../src/types";

describe("Native client platform", () => {
  it("uses native platform tools, window chrome, and application shortcuts", async () => {
    const environment = await ipc<EnvironmentInfo>("get_environment_info");
    expect(environment.platform).toBe(isMac ? "macos" : "windows");
    expect(environment.platformSupported).toBe(true);
    expect(environment.sshPath).toBeTruthy();
    expect(await ipc<boolean>("plugin:window|is_decorated", { label: "main" })).toBe(isMac);
    const catalog = await ipc<LocalShellCatalog>("list_local_shells");
    expect(catalog.profiles.some((shell) => shell.id === localShellId)).toBe(true);
    if (isMac) {
      expect(environment.sshPath).toBe("/usr/bin/ssh");
      expect(catalog.profiles.every((shell) => !shell.elevated)).toBe(true);
      await expect($("aria/Window controls")).not.toExist();
    } else {
      await expect($("aria/Window controls")).toBeDisplayed();
    }
    await openLocal();
    await terminalCommand("echo NATIVE_CLIENT_READY", "NATIVE_CLIENT_READY");
    await browser.keys([isMac ? "Meta" : "Control", "Shift", "p"]);
    await browser.keys("NULL");
    await expect($("[role=combobox][aria-label='Search commands']")).toBeDisplayed();
    await browser.keys("Escape");
    await terminalCommand("echo PALETTE_RETURNED_INPUT", "PALETTE_RETURNED_INPUT");
  });
});
