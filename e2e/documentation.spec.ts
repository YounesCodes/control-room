import "./isolation";
import { $, browser, expect } from "@wdio/globals";

describe("Documentation in the native app", () => {
  it("opens the default browser from the help button and stays available in Settings", async () => {
    const docs = $("aria/Open documentation");
    await expect(docs).toBeDisplayed();
    await expect(docs).toHaveAttribute("title", "Documentation (opens in your browser)");
    // Observe the UI's native request lifecycle without replacing its IPC implementation.
    await browser.execute(() => {
      const button = document.querySelector('[aria-label="Open documentation"]')!;
      const host = window as unknown as { documentationStarted: boolean };
      host.documentationStarted = false;
      const observer = new MutationObserver((records) => {
        if (
          button.getAttribute("aria-busy") === "true" ||
          records.some(({ oldValue }) => oldValue === "true")
        ) {
          host.documentationStarted = true;
        }
        if (host.documentationStarted && button.getAttribute("aria-busy") === "false")
          observer.disconnect();
      });
      observer.observe(button, {
        attributes: true,
        attributeFilter: ["aria-busy"],
        attributeOldValue: true,
      });
    });
    await docs.click();
    await browser.waitUntil(async () =>
      browser.execute(() => {
        const started = (window as unknown as { documentationStarted: boolean })
          .documentationStarted;
        return (
          started &&
          document.querySelector('[aria-label="Open documentation"]')?.getAttribute("aria-busy") ===
            "false"
        );
      }),
    );
    await expect(docs).toBeEnabled();
    await expect($("[role=alert]")).not.toExist();
    await $("aria/Open Settings").click();
    await expect(docs).toBeDisplayed();
    await expect($(".settings-page")).toBeDisplayed();
    await browser.saveScreenshot("test-results/desktop/documentation-settings.png");
  });
});
