import "./isolation";
import { $, $$, browser, expect } from "@wdio/globals";
import { addConnection, feature, ipc, runtime } from "./helpers";
import { focusNativeApp, nativeKey, typeNativeCommand } from "./native-input";
import type { HostCapabilities } from "../src/types";

// Explicit live fixture: never included in the offline suite and never skipped
// when the configured host lacks a required service or permission.
async function connect() {
  const host = process.env.CONTROL_ROOM_TEST_HOST;
  const user = process.env.CONTROL_ROOM_TEST_USER;
  if (!host || !user) throw new Error("Configured SSH fixture access is required");
  const saved = await addConnection(
    "Native keyboard fixture",
    host,
    user,
    process.env.CONTROL_ROOM_TEST_PORT || "22",
  );
  await ipc("set_connection_history_enabled", { connectionId: saved.id, enabled: false });
  await $(".host-main*=Native keyboard fixture").click();
  await browser.waitUntil(
    () => $('.session-tab-wrap.active[data-session-state="connected"]').isExisting(),
    { timeout: 30000 },
  );
  await focusNativeApp();
  return ipc<HostCapabilities>("refresh_capabilities", { connectionId: saved.id });
}

async function focus(selector: string, index = 0) {
  await browser.execute(
    (selector, index) => document.querySelectorAll<HTMLElement>(selector)[index].focus(),
    selector,
    index,
  );
}

async function graphKeys(label: string, inspector: string) {
  const selector = `[aria-label='${label}'] button.arch-chip`;
  await browser.waitUntil(async () => (await $$(selector)).length >= 2, {
    timeoutMsg: `${label} fixture must expose at least two graph nodes`,
  });
  await focus(selector);
  await nativeKey("end");
  expect(
    await browser.execute((selector) => {
      const nodes = document.querySelectorAll(selector);
      return document.activeElement === nodes[nodes.length - 1];
    }, selector),
  ).toBe(true);
  await nativeKey("home");
  expect(
    await browser.execute(
      (selector) => document.activeElement === document.querySelector(selector),
      selector,
    ),
  ).toBe(true);
  for (const key of ["left", "right", "up", "down"]) {
    // Start at the opposite edge so each direction has a real destination.
    const horizontal = key === "left" || key === "right";
    const reverse = key === "left" || key === "up";
    const index = await browser.execute(
      (selector, horizontal, reverse) => {
        const positions = Array.from(document.querySelectorAll<HTMLElement>(selector)).map(
          (node, index) => {
            const box = node.getBoundingClientRect();
            return { index, position: horizontal ? box.x + box.width / 2 : box.y + box.height / 2 };
          },
        );
        positions.sort((a, b) => a.position - b.position);
        if (positions.at(-1)!.position - positions[0].position <= 1)
          throw new Error("Fixture nodes do not exercise this graph direction");
        return (reverse ? positions.at(-1)! : positions[0]).index;
      },
      selector,
      horizontal,
      reverse,
    );
    await focus(selector, index);
    await nativeKey(key);
    await browser.waitUntil(async () => (await $$(selector + "[aria-pressed=true]")).length === 1);
    expect(await $$(selector)[index].getAttribute("aria-pressed")).toBe("false");
    await $(`[aria-label='${inspector}']`).waitForDisplayed();
    await nativeKey("escape");
    await expect($(`[aria-label='${inspector}']`)).not.toExist();
  }
}

describe("Native inspection shortcuts on a real SSH fixture", () => {
  it("uses the Logs search shortcut and returns to Terminal without intercepting shell control keys", async () => {
    const caps = await connect();
    expect(caps.journaldAvailable).toBe(true);
    await feature("Logs");
    await $("button=Start").waitForDisplayed();
    await nativeKey("primary+f");
    const search = $("[aria-label='Search loaded lines']");
    await expect(search).toBeFocused();
    await search.setValue("native search");
    await nativeKey("escape");
    await expect(search).toHaveValue("");
    const before = (await runtime()).sessionIds;
    // Workspace shortcuts deliberately leave ordinary text fields alone.
    await focus(".logs-page button");
    await nativeKey("primary+shift+t");
    await $(".terminal-workspace-pane.active .xterm-screen").waitForDisplayed();
    expect((await runtime()).sessionIds).toEqual(before);
  });

  it("reconnects SSH with the platform shortcut and a new native session", async () => {
    await connect();
    const before = (await runtime()).sessionIds;
    await nativeKey("primary+shift+r");
    await browser.waitUntil(
      async () => (await runtime()).sessionIds.some((id) => !before.includes(id)),
      { timeout: 30000 },
    );
    await typeNativeCommand("printf 'NATIVE_RECONNECTED\\n'", "NATIVE_RECONNECTED");
    expect((await runtime()).sessionIds).toHaveLength(1);
  });

  it("navigates Systemd inventory, refocuses its dependency graph, and dismisses inspectors and tools", async () => {
    const caps = await connect();
    expect(caps.systemdAvailable).toBe(true);
    await feature("Systemd");
    const rows = "[aria-label='Systemd units'] button.dense-row";
    await browser.waitUntil(async () => (await $$(rows)).length >= 2);
    await focus(rows);
    await nativeKey("down");
    await expect($$(rows)[1]).toHaveAttribute("aria-pressed", "true");
    await nativeKey("up");
    await expect($$(rows)[0]).toHaveAttribute("aria-pressed", "true");
    await nativeKey("end");
    expect(
      await browser.execute(() => {
        const list = document.querySelector<HTMLElement>("[aria-label='Systemd units']")!;
        return list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
      }),
    ).toBe(true);
    await nativeKey("home");
    await nativeKey("down");
    await $("[aria-label='Filter and sort units']").click();
    await $(".systemd-tools-panel").waitForDisplayed();
    await nativeKey("escape");
    await expect($(".systemd-tools-panel")).not.toExist();
    await $("button[aria-label^='Dependency graph']").click();
    await graphKeys("Systemd dependency graph", "Unit details");
    const nodes = "[aria-label='Systemd dependency graph'] button.arch-chip";
    await focus(nodes);
    const target = await browser.execute(
      (selector) => document.querySelector(selector)!.querySelector("strong")!.textContent!.trim(),
      nodes,
    );
    await nativeKey("shift+enter");
    await expect($("button[aria-label^='Dependency graph']")).toHaveAttribute(
      "aria-label",
      `Dependency graph ${target}`,
    );
    await expect($("[aria-label='Unit details']")).not.toExist();
  });

  it("navigates live Ports nodes and dismisses its inspector and toolbar", async () => {
    await connect();
    await feature("Ports");
    await graphKeys("Ports graph", "Port details");
    await $("[aria-label='Filter ports']").click();
    await $("[aria-label='Graph contents']").waitForDisplayed();
    await nativeKey("escape");
    await expect($("[aria-label='Graph contents']")).not.toExist();
  });

  it("navigates Docker graph nodes through the native arrow keys", async () => {
    const caps = await connect();
    if (!caps.dockerAvailable) throw new Error("Docker is required on the lab fixture");
    if (!caps.dockerAccessible) throw new Error("The lab account must have Docker read access");
    await feature("Docker");
    await graphKeys("Docker graph", "Container details");
  });
});
