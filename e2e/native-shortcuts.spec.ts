import "./isolation";
import { $, $$, browser, expect } from "@wdio/globals";
import { ipc, runtime } from "./helpers";
import { focusNativeApp, nativeKey, openNativeShell, typeNativeCommand } from "./native-input";

async function palette(action?: string) {
  await focusNativeApp();
  await nativeKey("primary+shift+p");
  const search = $("[aria-label='Search commands']");
  await search.waitForDisplayed();
  if (action) {
    await search.setValue(action);
    await nativeKey("enter");
    await $("[aria-label='Command palette']").waitForExist({ reverse: true });
  }
}
describe("Native application shortcuts and command palette", () => {
  it("opens the palette, navigates Home/End and arrows, cancels, and runs a selected action", async () => {
    await openNativeShell();
    await typeNativeCommand("echo PALETTE_READY", "PALETTE_READY");
    await palette();
    const options = await $$(".command-palette [role=option]");
    const search = $("[aria-label='Search commands']");
    await nativeKey("end");
    await expect(search).toHaveAttribute(
      "aria-activedescendant",
      await options.at(-1)!.getAttribute("id"),
    );
    await nativeKey("home");
    await expect(search).toHaveAttribute(
      "aria-activedescendant",
      await options[0].getAttribute("id"),
    );
    await nativeKey("down");
    await expect(search).toHaveAttribute(
      "aria-activedescendant",
      await options[1].getAttribute("id"),
    );
    await nativeKey("up");
    await expect(search).toHaveAttribute(
      "aria-activedescendant",
      await options[0].getAttribute("id"),
    );
    await nativeKey("escape");
    await expect($("[aria-label='Command palette']")).not.toExist();
    await palette("Rename workspace");
    await $("[role=dialog] input").setValue("Native palette workspace");
    await nativeKey("enter");
    await browser.waitUntil(
      async () =>
        (await ipc<{ workspaces: { label: string }[] }>("get_workspace_state")).workspaces[0]
          ?.label === "Native palette workspace",
    );
  });

  it("reorders focused tabs with the platform modifier and restarts only the active shell", async () => {
    await openNativeShell();
    await openNativeShell();
    const saved = () => ipc<{ workspaces: { id: string }[] }>("get_workspace_state");
    await browser.waitUntil(async () => (await saved()).workspaces.length === 2);
    const order = (await saved()).workspaces.map((workspace) => workspace.id);
    const sessions = (await runtime()).sessionIds;
    await $(".session-tab-wrap.active .session-tab-main").click();
    await nativeKey("primary+shift+left");
    await browser.waitUntil(async () => (await saved()).workspaces[0].id === order[1]);
    await nativeKey("primary+shift+right");
    await browser.waitUntil(async () => (await saved()).workspaces[0].id === order[0]);
    expect((await runtime()).sessionIds).toEqual(sessions);
    await nativeKey("primary+shift+r");
    await browser.waitUntil(async () =>
      (await runtime()).sessionIds.some((id) => !sessions.includes(id)),
    );
    await typeNativeCommand("echo SHORTCUT_RESTARTED", "SHORTCUT_RESTARTED");
    expect((await runtime()).sessionIds).toHaveLength(2);
  });

  it("finds terminal output, closes search, and confirms tab closure through the platform shortcut", async () => {
    await openNativeShell();
    await typeNativeCommand("echo NATIVE_FIND_NEEDLE", "NATIVE_FIND_NEEDLE");
    await nativeKey("primary+shift+f");
    await $("[aria-label='Find in terminal output']").waitForDisplayed();
    await $("[aria-label='Find in terminal output']").setValue("NATIVE_FIND_NEEDLE");
    await nativeKey("escape");
    await expect($("[aria-label='Find in terminal output']")).not.toExist();
    await nativeKey("primary+shift+w");
    await $("[role=dialog]").waitForDisplayed();
    await nativeKey("escape");
    await expect($("[role=dialog]")).not.toExist();
    await nativeKey("primary+shift+w");
    await $("button=Stop & close").click();
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 0);
  });

  it("uses Settings category and terminal-tab keys while preserving ordinary field editing", async () => {
    await openNativeShell();
    await palette("Open settings");
    const categories = $(".settings-navigation");
    await categories.$("button=General & Monitoring").click();
    await nativeKey("down");
    await expect(categories.$("button=Terminal")).toHaveAttribute("aria-current", "page");
    await nativeKey("end");
    await expect(categories.$("button=App & Diagnostics")).toHaveAttribute("aria-current", "page");
    await nativeKey("home");
    await expect(categories.$("button=General & Monitoring")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await nativeKey("down");
    await nativeKey("tab");
    await nativeKey("right");
    await expect($('[role="tab"]=Tabs & naming')).toHaveAttribute("aria-selected", "true");
    await nativeKey("end");
    await expect($('[role="tab"]=Local shells')).toHaveAttribute("aria-selected", "true");
    await nativeKey("left");
    await expect($('[role="tab"]=Tabs & naming')).toHaveAttribute("aria-selected", "true");
    await nativeKey("home");
    await expect($('[role="tab"]=Appearance')).toHaveAttribute("aria-selected", "true");
    const font = $(
      "input[aria-describedby='linux-font-help'], [role=combobox][aria-controls=font-suggestions]",
    );
    await font.setValue("abcd");
    await nativeKey("home");
    await nativeKey("right");
    expect(await font.getProperty("selectionStart")).toBe(1);
    await nativeKey("end");
    await nativeKey("left");
    expect(await font.getProperty("selectionStart")).toBe(3);
    await expect($('[role="tab"]=Appearance')).toHaveAttribute("aria-selected", "true");
    await $("[aria-label='Close Settings']").click();
    // Installed-font fields commit while editing; the catalog picker keeps a
    // typed query separate until the user chooses it.
    await browser.waitUntil(
      async () =>
        !(await $(".settings-page").isExisting()) || (await $("button=Discard").isExisting()),
    );
    if (await $("button=Discard").isExisting()) await $("button=Discard").click();
    await expect($(".settings-page")).not.toExist();
  });
});
