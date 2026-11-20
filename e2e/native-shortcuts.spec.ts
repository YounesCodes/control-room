import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { nativeKey, openNativeShell } from "./native-input";
import { isMac } from "./platform";

describe("Native keyboard navigation", () => {
  it("uses Settings category and terminal-tab keys while preserving ordinary field editing", async () => {
    await openNativeShell();
    await $("[aria-label='Open Settings']").click();
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
    // macOS uses Cmd+arrows to position the caret; Home/End scroll documents.
    await nativeKey(isMac ? "primary+left" : "home");
    await nativeKey("right");
    expect(await font.getProperty("selectionStart")).toBe(1);
    await nativeKey(isMac ? "primary+right" : "end");
    await nativeKey("left");
    expect(await font.getProperty("selectionStart")).toBe(3);
    await expect($('[role="tab"]=Appearance')).toHaveAttribute("aria-selected", "true");
    await $("[aria-label='Close Settings']").click();
    await browser.waitUntil(
      async () =>
        !(await $(".settings-page").isExisting()) || (await $("button=Discard").isExisting()),
    );
    if (await $("button=Discard").isExisting()) await $("button=Discard").click();
    await expect($(".settings-page")).not.toExist();
  });
});
