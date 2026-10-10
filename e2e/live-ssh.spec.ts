import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import {
  addConnection,
  connectionMenu,
  feature,
  ipc,
  restartApp,
  runtime,
  terminalCommand,
} from "./helpers";
import type {
  BootDiagnostics,
  DockerContainer,
  HostBaselineSummary,
  HostCapabilities,
  ListeningSocket,
  SystemdUnit,
} from "../src/types";

async function connect() {
  const host = process.env.CONTROL_ROOM_TEST_HOST;
  const user = process.env.CONTROL_ROOM_TEST_USER;
  if (!host || !user) throw new Error("Configured SSH fixture access is required");
  const saved = await addConnection(
    "Live fixture",
    host,
    user,
    process.env.CONTROL_ROOM_TEST_PORT || "22",
  );
  await ipc("set_connection_history_enabled", { connectionId: saved.id, enabled: false });
  await $(".host-main*=Live fixture").click();
  await browser.waitUntil(
    async () => $('.session-tab-wrap.active[data-session-state="connected"]').isExisting(),
    { timeout: 30_000 },
  );
  const caps = await ipc<HostCapabilities>("refresh_capabilities", { connectionId: saved.id });
  expect(caps.osId).toBe("ubuntu");
  expect(caps.systemdAvailable).toBe(true);
  return { saved, caps };
}

describe("read-only Ubuntu SSH journeys with independent native processes", () => {
  it("validates configured access and reads terminal output", async () => {
    await connect();
    await connectionMenu("Live fixture");
    await $("aria/Edit connection").click();
    await $("button=Test structured access").click();
    await browser.waitUntil(async () => $("[role=dialog] [role=status]").isExisting(), {
      timeout: 30_000,
    });
    await expect($("[role=dialog] [role=status]")).toHaveText(
      expect.stringContaining("Noninteractive SSH works"),
    );
    await $("button=Cancel").click();
    await terminalCommand("printf 'SSH_FIXTURE_OK\\n'", "SSH_FIXTURE_OK");
    expect((await runtime()).sessionIds).toHaveLength(1);
  });
  it("reconnects an exited terminal with a fresh native session", async () => {
    await connect();
    const old = (await runtime()).sessionIds[0];
    await $(".terminal-workspace-pane.active .xterm-screen").click();
    await browser.keys("exit");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 0);
    await $("aria/Reconnect terminal").click();
    await terminalCommand("printf 'RECONNECTED_OK\\n'", "RECONNECTED_OK");
    expect((await runtime()).sessionIds[0]).not.toBe(old);
  });
  it("reads Overview identity and capabilities without duplicate resource readings", async () => {
    await connect();
    await feature("Overview");
    await expect($(".overview-page")).toHaveText(expect.stringContaining("Ubuntu"));
    await expect($(".overview-page")).toHaveText(expect.stringMatching(/running services/i));
    await expect($(".overview-page")).not.toHaveText(expect.stringMatching(/live load/i));
    await expect($(".overview-page")).not.toHaveText(expect.stringMatching(/uptime/i));
    await expect($(".overview-page")).not.toHaveText(expect.stringMatching(/memory/i));
    await expect($("button=Pause")).not.toExist();
    await $("button=Refresh").click();
    await expect($("h2=Overview")).toBeDisplayed();
  });
  it("discovers Systemd units and selects a real unit", async () => {
    const { saved } = await connect();
    const units = await ipc<SystemdUnit[]>("list_services", { connectionId: saved.id });
    expect(units.length).toBeGreaterThan(0);
    await feature("Systemd");
    await $("input[placeholder='Search units']").setValue(units[0].id);
    await $(".dense-row").click();
    await expect($(".detail-panel")).toHaveText(expect.stringContaining(units[0].id));
  });
  it("reads Ports in graph and table views and reads connection evidence", async () => {
    const { saved } = await connect();
    const sockets = await ipc<ListeningSocket[]>("list_ports", {
      connectionId: saved.id,
      sudoPassword: null,
    });
    expect(sockets.some((socket) => socket.port > 0)).toBe(true);
    await feature("Ports");
    await expect($("h2=Ports")).toBeDisplayed();
    await $("button=Table").click();
    await expect($(".ports-page")).toHaveText(expect.stringContaining(String(sockets[0].port)));
    await $("button=Connections").click();
    await expect($(".ports-page")).toBeDisplayed();
  });
  it("reads current and discovered previous boot evidence without sudo", async () => {
    const { saved } = await connect();
    const current = await ipc<BootDiagnostics>("collect_boot_diagnostics", {
      connectionId: saved.id,
      bootId: null,
      sudoPassword: null,
    });
    expect(current.collectedAt).toBeTruthy();
    await feature("Boot");
    await expect($("h2=Boot Diagnostics")).toBeDisplayed();
    if (current.boots.permissionRequired || current.journal.permissionRequired)
      console.log("Optional journal evidence: limited account access; permission state verified");
    const previous = current.boots.data?.find((boot) => !boot.current);
    if (previous) {
      const evidence = await ipc<BootDiagnostics>("collect_boot_diagnostics", {
        connectionId: saved.id,
        bootId: previous.id,
        sudoPassword: null,
      });
      expect(evidence.selectedBootId).toBe(previous.id);
    } else console.log("Optional previous boot evidence: no retained previous boot available");
  });
  it("starts and stops journal streaming and tears down on navigation", async function () {
    const { saved, caps } = await connect();
    if (!caps.journaldAvailable) {
      console.log("Optional journal streaming unavailable: journald absent");
      this.skip();
    }
    const units = await ipc<SystemdUnit[]>("list_services", { connectionId: saved.id });
    await feature("Logs");
    await $("//label[span[normalize-space()='Unit']]/select").selectByAttribute(
      "value",
      units[0].id,
    );
    await $("button=Start").click();
    await browser.waitUntil(
      async () => (await runtime()).streamIds.length > 0 || (await $(".inline-error").isExisting()),
      { timeout: 30_000 },
    );
    if (await $(".inline-error").isExisting()) {
      const reason = await $(".inline-error").getText();
      if (!/permission denied/i.test(reason)) throw new Error(reason);
      console.log("Optional journal streaming unavailable: permission denied");
      if (await $("[role=dialog]").isExisting()) await $("button=Cancel").click();
      this.skip();
    }
    await $("button=Pause").click();
    await $("button=Resume").click();
    await feature("Overview");
    await browser.waitUntil(async () => (await runtime()).streamIds.length === 0);
  });
  it("discovers Docker containers and follows real container details to Logs", async function () {
    const { saved, caps } = await connect();
    if (!caps.dockerAvailable || !caps.dockerAccessible) {
      console.log(
        `Optional Docker unavailable: ${caps.dockerAvailable ? "account cannot access Docker" : "Docker absent"}`,
      );
      this.skip();
    }
    const containers = await ipc<DockerContainer[]>("list_containers", {
      connectionId: saved.id,
      sudoPassword: null,
    });
    await feature("Docker");
    await expect($("h2=Containers")).toBeDisplayed();
    if (!containers.length) {
      console.log("Optional Docker details: host has no containers");
      this.skip();
    }
    await $("input[placeholder='Search projects, services, or containers']").setValue(
      containers[0].name,
    );
    await $(".dense-row").click();
    await expect($(".container-inspector-panel")).toBeDisplayed();
    await $("button=View logs").click();
    await expect($("h2=Logs")).toBeDisplayed();
    await $("button=Start").click();
    await browser.waitUntil(
      async () =>
        (await runtime()).streamIds.length > 0 ||
        (await $(".logs-page [role=status]").getText()).includes("stopped"),
    );
    expect(await $(".inline-error").isExisting()).toBe(false);
    await feature("Overview");
    await browser.waitUntil(async () => (await runtime()).streamIds.length === 0);
  });
  it("persists baselines locally and compares stored and live state", async () => {
    const { saved } = await connect();
    await feature("Baselines");
    for (const label of ["Before", "After"]) {
      await $("aria/Baseline label").setValue(label);
      await $("button=Capture baseline").click();
      await browser.waitUntil(
        async () =>
          (
            await ipc<HostBaselineSummary[]>("list_host_baselines", { connectionId: saved.id })
          ).some((capture) => capture.label === label),
        { timeout: 60_000 },
      );
    }
    const stored = await ipc<HostBaselineSummary[]>("list_host_baselines", {
      connectionId: saved.id,
    });
    expect(stored).toHaveLength(2);
    const compared = await ipc<{ schemaCompatible: boolean }>("compare_host_baselines", {
      baseId: stored[1].id,
      targetId: stored[0].id,
    });
    expect(compared.schemaCompatible).toBe(true);
    await restartApp();
    expect(
      await ipc<HostBaselineSummary[]>("list_host_baselines", { connectionId: saved.id }),
    ).toHaveLength(2);
    await feature("Baselines");
    await $(`#baseline-row-${stored[0].id}`).click();
    await $(".baseline-compare-field select").selectByAttribute("value", "live");
    await browser.waitUntil(async () => $(".baseline-comparison-note").isExisting(), {
      timeout: 60_000,
    });
    await expect($(".baseline-comparison-note")).toHaveText(
      expect.stringContaining("This read was not saved"),
    );
    expect(
      await ipc<HostBaselineSummary[]>("list_host_baselines", { connectionId: saved.id }),
    ).toHaveLength(2);
  });
});
