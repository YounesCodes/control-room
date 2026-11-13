import { browser, expect } from "@wdio/globals";
import { ipc, restartApp } from "./helpers";
async function state() {
  return {
    native: await ipc("e2e_window_state", { activate: false }),
    document: await browser.execute(() => ({
      hidden: document.hidden,
      focused: document.hasFocus(),
      width: innerWidth,
      height: innerHeight,
      url: location.href,
    })),
    visible: await ipc("plugin:window|is_visible", { label: "main" }),
    focused: await ipc("plugin:window|is_focused", { label: "main" }),
    windows: await ipc("plugin:window|get_all_windows"),
  };
}
describe("macOS native visibility reproduction", () => {
  it("has a visible main document before and after native restart", async () => {
    console.log("[VISIBILITY-PROBE] initial", JSON.stringify(await state()));
    await restartApp(false);
    console.log("[VISIBILITY-PROBE] restarted", JSON.stringify(await state()));
    console.log(
      "[VISIBILITY-PROBE] activate",
      JSON.stringify(await ipc("e2e_window_state", { activate: true })),
    );
    console.log("[VISIBILITY-PROBE] activated", JSON.stringify(await state()));
    expect(await browser.execute(() => document.visibilityState)).toBe("visible");
  });
});
