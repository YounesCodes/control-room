import { savedSettings } from "./helpers";
import { homedir } from "node:os";
import { isMac, isLinux } from "./platform";
import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Explicit local check only. Normal desktop tests need no public font service.
const liveFonts = isLinux || process.env.CONTROL_ROOM_LIVE_FONTS === "1" ? describe : describe.skip;

liveFonts("public font catalog in the native WebView", () => {
  it("renders a font preview without installing or changing the saved font", async () => {
    const localData = process.env.LOCALAPPDATA;
    if (!isMac && !isLinux && !localData)
      throw new Error("LOCALAPPDATA is required to inspect user-installed fonts.");
    const folder = isMac
      ? join(homedir(), "Library", "Fonts")
      : isLinux
        ? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "fonts")
        : join(localData!, "Microsoft", "Windows", "Fonts");
    const paths = [400, 700].map((weight) =>
      join(folder, `ControlRoom-jetbrains-mono-${weight}.ttf`),
    );
    const snapshot = () =>
      paths.map((path) =>
        existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null,
      );
    const before = snapshot();
    await $("aria/Open Settings").click();
    await $(".settings-navigation").$("button=Terminal").click();
    if (isLinux) {
      // Linux offers installed desktop fonts rather than the online font catalog.
      const settings = await savedSettings();
      const current = $('input[aria-describedby="linux-font-help"]');
      await current.setValue("monospace");
      await browser.waitUntil(() =>
        browser.execute(
          () =>
            document.querySelector<HTMLElement>(".ansi-preview")?.style.fontFamily === "monospace",
        ),
      );
      expect((await savedSettings()).terminalFontFamily).toBe(settings.terminalFontFamily);
      expect(snapshot()).toEqual(before);
      await $("aria/Close Settings").click();
      await $("button=Discard").click();
      return;
    }
    const current = $("[role=combobox][aria-controls=font-suggestions]");
    const original = await current.getValue();
    await current.click();
    if (isMac) await current.setValue("JetBrains Mono");
    else await browser.keys("JetBrains Mono");
    await expect(current).toHaveValue("JetBrains Mono");
    try {
      await $("#font-option-jetbrains-mono").waitForDisplayed({ timeout: 30_000 });
    } catch (error) {
      throw new Error(`Font catalog: ${await $(".font-catalog").getText()}. ${String(error)}`, {
        cause: error,
      });
    }
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const alias = "ControlRoomPreview-jetbrains-mono";
          let loaded = false;
          document.fonts.forEach((face) => {
            if (face.family === alias && face.status === "loaded") loaded = true;
          });
          return (
            loaded &&
            Boolean(
              document
                .querySelector<HTMLElement>(".ansi-preview")
                ?.style.fontFamily.includes(alias),
            )
          );
        }),
      { timeout: 30_000, timeoutMsg: "The native font preview did not load in WebView2" },
    );
    await expect($("#font-option-jetbrains-mono span")).toHaveText("JetBrains Mono");
    await browser.keys("Escape");
    await expect(current).toHaveValue(original);
    await expect($("#font-suggestions")).not.toBeDisplayed();
    expect(snapshot()).toEqual(before);
    await $("button[aria-label='Close Settings']").click();
  });
});
