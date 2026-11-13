import { isWindows, localShellLabel } from "./platform";
import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { openLocal, runtime, terminalCommand, terminalContains, typeTerminalText } from "./helpers";

describe("Shell-reported terminal titles", () => {
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
    await typeTerminalText(
      `node -e "${report}process.stdin.once('data',function(){process.stdout.write(String.fromCharCode(27)+']133;D;0'+String.fromCharCode(7));process.exit(0)})" ${isWindows ? "&" : ";"} echo TITLE_FINISHED`,
    );
    await browser.keys("Enter");
    await expect(tab.$(".session-tab-label")).toHaveText(`python · ${localShellLabel}`);
    await expect(tab).toHaveAttribute("title", `python · ${localShellLabel}`);
    await browser.keys("Enter");
    await terminalContains("TITLE_FINISHED");
    await expect(tab.$(".session-tab-label")).toHaveText(localShellLabel);
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
    await expect(tab.$(".session-tab-label")).toHaveText("Build");
    expect((await runtime()).sessionIds).toEqual(sessions);
  });
});
