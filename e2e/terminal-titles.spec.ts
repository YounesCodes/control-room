import { isMac } from "./platform";
import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { openLocal, runtime, terminalCommand, terminalContains } from "./helpers";

// Drives cmd.exe syntax and Windows ConPTY title forwarding. Title parsing is
// platform-neutral and covered by the terminal surface browser tests.
(isMac ? describe.skip : describe)("Shell-reported terminal titles", () => {
  it("shows only the program, restores identity on prompt return and preserves manual names", async () => {
    await openLocal();
    await terminalCommand("echo TITLE_READY", "TITLE_READY");
    const sessions = (await runtime()).sessionIds;
    const tab = $(".session-tab-wrap.active .session-tab-main");
    await $(".terminal-workspace-pane.active .xterm-screen").click();
    // Emit OSC metadata directly: Windows Server ConPTY does not consistently
    // forward cmd.exe's SetConsoleTitle updates.
    const report =
      "process.stdout.write(String.fromCharCode(27)+']0;python --token private-title-argument'+String.fromCharCode(7));";
    await browser.keys(
      `node -e "${report}process.stdin.once('data',function(){process.exit(0)})" & echo TITLE_FINISHED`,
    );
    await browser.keys("Enter");
    await expect(tab).toHaveText("python · Command Prompt");
    await expect(tab).toHaveAttribute("title", "python · Command Prompt");
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
