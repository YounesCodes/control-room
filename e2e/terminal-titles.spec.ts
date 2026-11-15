import { isWindows, localShellLabel } from "./platform";
import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import {
  openLocal,
  runtime,
  terminalCommand,
  terminalContains,
  typeTerminalText,
  expectNativeText,
} from "./helpers";

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
    await typeTerminalText(
      `node -e "${report}process.stdin.once('data',function(){process.stdout.write(String.fromCharCode(27)+']133;D;0'+String.fromCharCode(7));process.exit(0)})" ${isWindows ? "&" : ";"} echo TITLE_FINISHED`,
    );
    // The title comes from the line the shell echoed, so let the echo arrive first.
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Array.from(
            document.querySelectorAll(".terminal-workspace-pane.active .xterm-rows > div"),
            (row) => row.textContent ?? "",
          )
            .join("")
            .includes(`${isWindows ? "&" : ";"} echo TITLE_FINISHED`),
        ),
      { timeout: 15_000, timeoutMsg: "the shell did not echo the command" },
    );
    await browser.keys("Enter");
    await expectNativeText(await tab.$(".session-tab-label"), `node · ${localShellLabel}`);
    await expect(tab).toHaveAttribute("title", `node · ${localShellLabel}`);
    await browser.keys("Enter");
    await terminalContains("TITLE_FINISHED");
    await expectNativeText(await tab.$(".session-tab-label"), localShellLabel);
    await tab.moveTo();
    await $(".session-tab-wrap.active .session-tab-rename").click();
    await $("[role=dialog] input").setValue("Build");
    await $("button=Rename").click();
    await terminalCommand(
      isWindows
        ? "title npm --token private-title-argument & echo MANUAL_TITLE_OK"
        : `printf '\\033]0;npm --token private-title-argument\\007'; echo MANUAL_TITLE_OK`,
      "MANUAL_TITLE_OK",
    );
    await expectNativeText(await tab.$(".session-tab-label"), "Build");
    expect((await runtime()).sessionIds).toEqual(sessions);
  });
});
