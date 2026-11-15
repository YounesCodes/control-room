import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { addConnection, feature, ipc, restartApp, runtime, terminalCommand } from "./helpers";
import type { DockerContainer, HostCapabilities, ListeningSocket, SystemdUnit } from "../src/types";

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
  it("launches zsh and reads native services, sockets and managed unified logs", async () => {
    const { saved } = await connect();
    await terminalCommand("printf '\\nMAC_REMOTE_%s\\n' ZSH_OK", "MAC_REMOTE_ZSH_OK");
    const jobs = await ipc<SystemdUnit[]>("list_services", { connectionId: saved.id });
    expect(jobs.some((job) => job.id === "system/com.openssh.sshd")).toBe(true);
    await feature("Services");
    await $("input[placeholder='Search services']").setValue("com.openssh.sshd");
    await $(
      "//button[contains(@class,'dense-row')][.//strong[normalize-space()='system/com.openssh.sshd']]",
    ).click();
    await expect($("button=View logs")).toBeDisplayed();
    const sockets = await ipc<ListeningSocket[]>("list_ports", {
      connectionId: saved.id,
      sudoPassword: null,
    });
    expect(sockets.some((socket) => socket.port === 22)).toBe(true);
    await feature("Ports");
    await $(".ports-page .arch-chip").waitForExist({ timeout: 30_000 });
    await expect($(".ports-page")).toHaveText(expect.stringContaining("22"));
    await feature("Logs");
    await $("//label[span[normalize-space()='Service']]/select").selectByAttribute("value", "all");
    await $("button=Start").click();
    await browser.waitUntil(async () => (await runtime()).streamIds.length === 1, {
      timeout: 30_000,
    });
    await $("button=Pause").click();
    await $("button=Resume").click();
    await feature("Terminal");
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
    const heading = $(".docker-page h2=Containers");
    await heading.waitForDisplayed({ timeout: 30_000 });
    await expect(heading).toHaveAttribute("title", expect.stringContaining(caps.dockerContext!));
    const chip = $(`.docker-page .arch-chip*=${containers[0].name}`);
    await chip.waitForExist({ timeout: 30_000 });
    // Graph chips select on pointer press; the embedded driver sends no
    // PointerEvents, so activate the chip the way keyboard users do.
    await browser.execute((node: HTMLElement) => node.click(), await chip);
    await $("aside[aria-label='Container details']").waitForDisplayed();
    await $("aside[aria-label='Container details']").$("button*=View logs").click();
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

  it("restores the selected Mac shell after restarting the app", async () => {
    await connect();
    await restartApp();
    await browser.waitUntil(
      async () => $('.session-tab-wrap.active[data-session-state="connected"]').isExisting(),
      { timeout: 30_000 },
    );
    await feature("Terminal");
    await terminalCommand("printf '\\nMAC_RESTORED_%s\\n' OK", "MAC_RESTORED_OK");
  });
});
