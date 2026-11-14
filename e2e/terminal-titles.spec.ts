import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { openLocal, runtime, terminalCommand, terminalContains } from "./helpers";

describe("Command-based terminal titles", () => {
  it("shows the typed program over window titles, restores identity on prompt return and preserves manual names", async () => {
    await openLocal();
    await terminalCommand("echo TITLE_READY", "TITLE_READY");
    const sessions = (await runtime()).sessionIds;
    const tab = $(".session-tab-wrap.active .session-tab-main");
    await $(".terminal-workspace-pane.active .xterm-screen").click();
    // The program sets a misleading window title. The tab names the command
    // typed at the prompt, never the window title or its arguments.
    const report =
      "process.stdout.write(String.fromCharCode(27)+']0;python --token private-title-argument'+String.fromCharCode(7));";
    await browser.keys(
      `node -e "${report}process.stdin.once('data',function(){process.exit(0)})" & echo TITLE_FINISHED`,
    );
    // The title comes from the line cmd echoed, so let the echo arrive first.
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Array.from(
            document.querySelectorAll(".terminal-workspace-pane.active .xterm-rows > div"),
            (row) => row.textContent ?? "",
          )
            .join("")
            .includes("& echo TITLE_FINISHED"),
        ),
      { timeout: 15_000, timeoutMsg: "cmd did not echo the command" },
    );
    await browser.keys("Enter");
    await expect(tab).toHaveText("node · Command Prompt");
    await expect(tab).toHaveAttribute("title", "node · Command Prompt");
    await browser.keys("Enter");
    await terminalContains("TITLE_FINISHED");
    await expect(tab).toHaveText("Command Prompt");
    await tab.moveTo();
    await $(".session-tab-wrap.active .session-tab-rename").click();
    await $("[role=dialog] input").setValue("Build");
    await $("button=Rename").click();
    await terminalCommand(
      "title npm --token private-title-argument & echo MANUAL_TITLE_OK",
      "MANUAL_TITLE_OK",
    );
    await expect(tab).toHaveText("Build");
    expect((await runtime()).sessionIds).toEqual(sessions);
  });
});
