import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { addConnection, feature, ipc, restartApp, runtime, terminalCommand } from "./helpers";
import type {
  AppSettings,
  HostCapabilities,
  RemoteShellCatalog,
  ListeningSocket,
  WindowsService,
  HeaderMetrics,
} from "../src/types";

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
    await $("input[name='remote-shell']").waitForExist({ timeout: 60_000 });
    const catalog = await ipc<RemoteShellCatalog>("discover_remote_shells", {
      connectionId: saved.id,
    });
    expect(catalog.platform).toBe("windows");
    const profile = catalog.shells.find((shell) => shell.id === shellId);
    if (!profile) throw new Error(`Expected test shell ${shellId} is not available`);
    await $("[role=dialog]")
      .$("aria/" + profile.label)
      .click();
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
    await expect($(".feature-nav").$("button=Ports")).toExist();
  });
  it("reports missing Windows Docker without PowerShell serialization", async function () {
    const saved = await connect("powershell");
    const capabilities = await ipc<HostCapabilities>("get_cached_capabilities", {
      connectionId: saved.id,
    });
    if (capabilities.dockerAvailable) this.skip();
    for (const view of ["Docker", "Logs"]) {
      await feature(view);
      await $(".panel-state-error p").waitForExist({ timeout: 30_000 });
      await expect($(".panel-state-error p")).toHaveText("Docker is not installed on this host.");
      await expect($("button=Retry")).toBeDisplayed();
      if (view === "Docker") {
        await $(".panel-state-error").saveScreenshot(
          "test-results/desktop/windows-docker-unavailable.png",
        );
      }
    }
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
  it("reads Windows ports, services, and enabled header resources through the UI", async () => {
    const saved = await connect("powershell");
    const sockets = await ipc<ListeningSocket[]>("list_ports", { connectionId: saved.id });
    expect(sockets.some((socket) => socket.port === 22 && socket.protocol === "tcp")).toBe(true);
    await feature("Ports");
    await $("button=Table").click();
    await browser.waitUntil(
      async () =>
        $(".feature-page")
          .getText()
          .then((text) => text.includes("sshd")),
      { timeout: 30_000 },
    );
    await feature("Services");
    await $("input[aria-label='Search Windows services']").setValue("sshd");
    await $(".dense-row").click();
    await expect($(".detail-panel")).toHaveText(expect.stringContaining("OpenSSH"));
    const services = await ipc<WindowsService[]>("list_windows_services", {
      connectionId: saved.id,
    });
    expect(services.some((service) => service.id === "sshd" && service.state === "running")).toBe(
      true,
    );
    const contract = await ipc<{ current: AppSettings }>("get_settings_contract");
    await ipc("save_settings", {
      settings: {
        ...contract.current,
        hostMetricsEnabled: true,
        hostMetrics: ["cpu", "ram", "disk", "uptime"],
        hostMetricsIntervalSeconds: 30,
      },
    });
    await restartApp(true);
    await $(".host-metrics").waitForExist({ timeout: 30_000 });
    await $(".host-metrics-status[data-state='live']").waitForExist({ timeout: 30_000 });
    const metrics = await ipc<HeaderMetrics>("sample_header_metrics", {
      connectionId: saved.id,
      metrics: ["cpu", "ram", "disk", "uptime"],
    });
    expect(metrics.memoryTotalKib).toBeGreaterThan(0);
    expect(metrics.diskTotalKib).toBeGreaterThan(0);
    expect(metrics.uptimeSeconds).toBeGreaterThan(0);
  });
});
