import "./isolation";
import { $, browser, expect } from "@wdio/globals";

describe("Documentation in the native app", () => {
  it("opens the default browser through native IPC and stays available in Settings", async () => {
    const docs = $("aria/Open documentation");
    await expect(docs).toBeDisplayed();
    await expect(docs).toHaveAttribute("title", "Documentation (opens in your browser)");
    await browser.tauri.execute(async ({ core }) => {
      await core.invoke("open_documentation");
    });
    await $("aria/Open Settings").click();
    await expect(docs).toBeDisplayed();
    await expect($(".settings-page")).toBeDisplayed();
    await browser.saveScreenshot("test-results/desktop/documentation-settings.png");
  });
});
