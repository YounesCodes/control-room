import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { addConnection, feature, ipc, restartApp, runtime, terminalCommand } from "./helpers";
import type {
  BootDiagnostics,
  DockerContainer,
  HostBaselineSummary,
  HostCapabilities,
  SystemdUnit,
} from "../src/types";

async function connect(shell = "zsh") {
  const host = process.env.CONTROL_ROOM_TEST_MAC_HOST;
  const user = process.env.CONTROL_ROOM_TEST_MAC_USER;
  if (!host || !user)
    throw new Error("CONTROL_ROOM_TEST_MAC_HOST and CONTROL_ROOM_TEST_MAC_USER are required");
  const saved = await addConnection(
    "Mac fixture",
    host,
    user,
    process.env.CONTROL_ROOM_TEST_MAC_PORT || "22",
  );
  await $(".host-main*=Mac fixture").click();
  await $("[role=dialog]").waitForDisplayed();
  await $(`input[type=radio][value='macos:${shell}']`).waitForExist({ timeout: 30_000 });
  await $(`input[type=radio][value='macos:${shell}']`).click();
  await $("button=Connect").click();
  await browser.waitUntil(
    async () => $('.session-tab-wrap.active[data-session-state="connected"]').isExisting(),
    { timeout: 30_000 },
  );
  const caps = await ipc<HostCapabilities>("refresh_capabilities", { connectionId: saved.id });
  expect(caps.osId).toBe("macos");
  expect(caps.launchdAvailable).toBe(true);
  expect(caps.systemdAvailable).toBe(false);
  return { saved, caps };
}

describe("macOS SSH host journeys against a real Mac", () => {
  it("launches zsh and reads native services, sockets, boots and managed unified logs", async () => {
    const { saved } = await connect();
    await terminalCommand("printf '\\nMAC_REMOTE_%s\\n' ZSH_OK", "MAC_REMOTE_ZSH_OK");
    await feature("Overview");
    await expect($(".overview-page")).toHaveText(expect.stringContaining("macOS"));
    const jobs = await ipc<SystemdUnit[]>("list_services", { connectionId: saved.id });
    expect(jobs.some((job) => job.id === "system/com.openssh.sshd")).toBe(true);
    await feature("Services");
    await $("input[placeholder='Search services']").setValue("com.openssh.sshd");
    await $(
      "//button[contains(@class,'dense-row')][.//strong[normalize-space()='system/com.openssh.sshd']]",
    ).click();
    await expect($("button=View logs")).toBeDisplayed();
    await feature("Ports");
    await $(".ports-tabs").waitForExist();
    await $("//button[@role='tab' and normalize-space()='Table']").click();
    await expect($(".ports-page")).toHaveText(expect.stringContaining("22"));
    await feature("Boot");
    await $("h2=Boot Diagnostics").waitForDisplayed({ timeout: 30_000 });
    await expect($("h3=Launchd service exits")).toBeDisplayed();
    expect(await $("h3=Slow units").isExisting()).toBe(false);
    const boot = await ipc<BootDiagnostics>("collect_boot_diagnostics", {
      connectionId: saved.id,
      bootId: null,
      sudoPassword: null,
    });
    expect(boot.journal.error).toBeNull();
    await feature("Logs");
    await $("//label[span[normalize-space()='Service']]/select").selectByAttribute("value", "all");
    await $("button=Start").click();
    await browser.waitUntil(async () => (await runtime()).streamIds.length === 1, {
      timeout: 30_000,
    });
    await $("button=Pause").click();
    await $("button=Resume").click();
    await feature("Overview");
    await browser.waitUntil(async () => (await runtime()).streamIds.length === 0);
  });

  it("uses Bash and reads Docker through the account's selected context", async () => {
    const { saved, caps } = await connect("bash");
    await terminalCommand("printf '\\nMAC_REMOTE_%s\\n' BASH_OK", "MAC_REMOTE_BASH_OK");
    expect(caps.dockerAccessible).toBe(true);
    expect(caps.dockerContext).toBeTruthy();
    const containers = await ipc<DockerContainer[]>("list_containers", {
      connectionId: saved.id,
      sudoPassword: null,
    });
    expect(containers.length).toBeGreaterThan(0);
    await feature("Docker");
    await $("h2=Containers").waitForDisplayed();
    await expect($(".page-heading")).toHaveText(expect.stringContaining(caps.dockerContext!));
    await $("input[placeholder='Search projects, services, or containers']").setValue(
      containers[0].name,
    );
    await $(`.dense-row[data-container-id="${containers[0].id}"]`).click();
    await $(".container-inspector-panel").waitForDisplayed();
    await $("button=View logs").click();
    await $("button=Start").click();
    await browser.waitUntil(
      async () => (await runtime()).streamIds.length > 0 || (await $(".inline-error").isExisting()),
      { timeout: 30_000 },
    );
    expect(await $(".inline-error").isExisting()).toBe(false);
    await feature("History");
    await browser.waitUntil(async () => (await runtime()).streamIds.length === 0);
    await expect($("h3=Enable exact Bash and zsh command history")).toBeDisplayed();
  });

  it("saves Mac baselines, restores the selected shell, and compares live state", async () => {
    const { saved } = await connect();
    await feature("Baselines");
    await $("aria/Baseline label").setValue("Mac before");
    await $("button=Capture baseline").click();
    await browser.waitUntil(
      async () =>
        (await ipc<HostBaselineSummary[]>("list_host_baselines", { connectionId: saved.id }))
          .length === 1,
      { timeout: 60_000 },
    );
    const [capture] = await ipc<HostBaselineSummary[]>("list_host_baselines", {
      connectionId: saved.id,
    });
    await restartApp();
    expect(
      (await ipc<HostBaselineSummary[]>("list_host_baselines", { connectionId: saved.id }))[0].id,
    ).toBe(capture.id);
    await feature("Terminal");
    await terminalCommand("printf '\\nMAC_RESTORED_%s\\n' OK", "MAC_RESTORED_OK");
    await feature("Baselines");
    await $(`#baseline-row-${capture.id}`).click();
    await $(".baseline-compare-field select").selectByAttribute("value", "live");
    await $(".baseline-comparison-note").waitForExist({ timeout: 60_000 });
    await expect($(".baseline-comparison-note")).toHaveText(
      expect.stringContaining("This read was not saved"),
    );
    expect(
      await ipc<HostBaselineSummary[]>("list_host_baselines", { connectionId: saved.id }),
    ).toHaveLength(1);
  });
});
