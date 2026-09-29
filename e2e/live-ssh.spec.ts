import { $, browser, expect } from "@wdio/globals";

describe("local Ubuntu SSH fixture", () => {
  it("tests access, opens a real terminal, and reads Overview and Systemd", async () => {
    const host = process.env.CONTROL_ROOM_TEST_HOST;
    const user = process.env.CONTROL_ROOM_TEST_USER;
    if (!host || !user) throw new Error("Local SSH fixture configuration is missing");

    await $(".sidebar-primary").click();
    await $("aria/Display name").setValue("Local lab fixture");
    await $("aria/SSH destination").setValue(host);
    await $("aria/Username").setValue(user);
    await $(".port-field input").setValue(process.env.CONTROL_ROOM_TEST_PORT || "22");
    await $("button=Test structured access").click();
    await browser.waitUntil(
      async () => (await $("[role=status]").getText()).includes("Noninteractive SSH works"),
      { timeout: 30_000, timeoutMsg: "Structured SSH access did not succeed" },
    );
    await $(".modal-actions button[type=submit]").click();

    await $(".host-main*=Local lab fixture").click();
    try {
      await browser.waitUntil(
        async () => await $(".session-tab-wrap.active .presence-connected").isExisting(),
        { timeout: 30_000, timeoutMsg: "The SSH terminal did not reach the connected state" },
      );
    } catch {
      const tab = await $(".session-tab-wrap.active .session-tab-main");
      const describedBy = await tab.getAttribute("aria-describedby");
      const state = describedBy ? await $(`#${describedBy}`).getText() : "unknown";
      const notice = (await $(".terminal-notice").isExisting())
        ? await $(".terminal-notice").getText()
        : "none";
      throw new Error(`SSH terminal state: ${state}; notice: ${notice}`);
    }
    const screen = $(".terminal-container .xterm-screen");
    await expect(screen).toBeDisplayed();
    await screen.click();
    await browser.keys("printf CONTROL_ROOM_LAB_OK; echo");
    await browser.keys("Enter");
    await browser.waitUntil(
      async () => {
        const lines = await browser.execute(() =>
          Array.from(document.querySelectorAll(".terminal-container .xterm-rows > div"), (row) =>
            row.textContent?.trim(),
          ),
        );
        return lines.includes("CONTROL_ROOM_LAB_OK");
      },
      { timeout: 15_000, timeoutMsg: "The Ubuntu shell did not print through ConPTY" },
    );

    await $("nav[aria-label='Workspace features']").$("button=Overview").click();
    await expect($("h2=Overview")).toBeDisplayed();
    await browser.waitUntil(async () => (await $(".overview-page").getText()).includes("Ubuntu"), {
      timeout: 30_000,
      timeoutMsg: "Overview did not identify the Ubuntu VM",
    });
    await $("nav[aria-label='Workspace features']").$("button=Systemd").click();
    await expect($("h2=Systemd")).toBeDisplayed();
    await browser.waitUntil(
      async () =>
        browser.execute(() => document.querySelectorAll(".dense-list .dense-row").length > 0),
      {
        timeout: 30_000,
        timeoutMsg: "The Systemd view did not show the VM's units",
      },
    );

    await $(".session-tab-wrap.active .session-tab-main").moveTo();
    await $("aria/Close Local lab fixture Workspace").click();
    await $("button=Disconnect & close").click();
    const fixtureMenu = $("aria/Open actions for Local lab fixture");
    await fixtureMenu.moveTo();
    await fixtureMenu.click();
    await $("aria/Delete connection").click();
    await $("button=Delete connection").click();
    await expect($(".host-main*=Local lab fixture")).not.toExist();
  });
});
