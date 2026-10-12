import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { addConnection, feature, ipc, restartApp, runtime, terminalCommand } from "./helpers";
import type { HostCapabilities, RemoteShellCatalog } from "../src/types";

// Opt-in fixture identity stays in environment variables, outside the repository.
const host = process.env.CONTROL_ROOM_WINDOWS_TEST_HOST;
const user = process.env.CONTROL_ROOM_WINDOWS_TEST_USER;
(host && user ? describe : describe.skip)("Windows SSH shell journeys", () => {
  async function connect(shellId: string) {
    const saved = await addConnection(
      "Windows test host",
      host!,
      user!,
      process.env.CONTROL_ROOM_WINDOWS_TEST_PORT || "22",
    );
    await $(".host-main*=Windows test host").click();
    await $("select[aria-label='Remote shell']").waitForExist({ timeout: 60_000 });
    const catalog = await ipc<RemoteShellCatalog>("discover_remote_shells", {
      connectionId: saved.id,
    });
    expect(catalog.platform).toBe("windows");
    const profile = catalog.shells.find((shell) => shell.id === shellId);
    if (!profile) throw new Error(`Expected test shell ${shellId} is not available`);
    await $("select[aria-label='Remote shell']").selectByAttribute("value", profile.id);
    await $("[role=dialog]").$("button=Connect").click();
    await browser.waitUntil(
      async () => $('.session-tab-wrap.active[data-session-state="connected"]').isExisting(),
      { timeout: 60_000 },
    );
    return saved;
  }
  it("connects PowerShell, reads Windows identity, and hides Linux navigation", async () => {
    const saved = await connect("powershell");
    await terminalCommand("Write-Output ('WINDOWS_' + 'SSH_OK')", "WINDOWS_SSH_OK");
    const capabilities = await ipc<HostCapabilities>("get_cached_capabilities", {
      connectionId: saved.id,
    });
    expect(capabilities.osId).toBe("windows");
    await feature("Overview");
    await expect($(".overview-page")).toHaveText(expect.stringContaining("Windows"));
    await expect($(".feature-nav").$("button=Systemd")).not.toExist();
    await expect($(".feature-nav").$("button=Ports")).not.toExist();
  });
  it("connects Command Prompt and reconnects after a clean exit", async () => {
    await connect("cmd");
    const old = (await runtime()).sessionIds[0];
    await terminalCommand("echo CMD_SSH_OK", "CMD_SSH_OK");
    await $(".terminal-workspace-pane.active .xterm-screen").click();
    await browser.keys("exit");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 0);
    await $("aria/Reconnect terminal").click();
    await terminalCommand("echo CMD_RECONNECTED_OK", "CMD_RECONNECTED_OK");
    expect((await runtime()).sessionIds[0]).not.toBe(old);
  });
  it("opens the selected WSL distribution and preserves it across an app restart", async () => {
    const distribution = process.env.CONTROL_ROOM_WINDOWS_TEST_WSL;
    if (!distribution) return;
    await connect(`wsl:${distribution}`);
    await terminalCommand("printf 'WSL_%s\\n' SSH_OK", "WSL_SSH_OK");
    await browser.pause(600);
    await restartApp(true);
    await browser.waitUntil(
      async () => $('.session-tab-wrap.active[data-session-state="connected"]').isExisting(),
      { timeout: 60_000 },
    );
    await terminalCommand("printf 'WSL_%s\\n' RESTORED_OK", "WSL_RESTORED_OK");
  });
});
