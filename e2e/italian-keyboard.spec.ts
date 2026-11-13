import "./isolation";
import { $, expect } from "@wdio/globals";
import { terminalContains } from "./helpers";
import {
  focusNativeApp,
  nativeKey,
  openNativeShell,
  typeItalianAccents,
  withItalianLayout,
} from "./native-input";

describe("Italian native keyboard layout", () => {
  it(
    process.platform === "win32"
      ? "enters standard Italian accents in a text field"
      : "enters accented text and composes dead keys in a text field",
    async () => {
      await openNativeShell();
      await $(".sidebar-primary").click();
      await $("aria/Display name").click();
      await focusNativeApp();
      await withItalianLayout(async () => {
        typeItalianAccents();
        await expect($("aria/Display name")).toHaveValue("èé");
      });
      await nativeKey("escape");
    },
  );
  it(
    process.platform === "win32"
      ? "delivers standard Italian accents to the real PTY"
      : "delivers Italian accents and composed text to the real PTY",
    async () => {
      await openNativeShell();
      await $(".terminal-workspace-pane.active .xterm-helper-textarea").addValue("echo ITALIAN_");
      await withItalianLayout(async () => {
        typeItalianAccents();
        await $(".terminal-workspace-pane.active .xterm-helper-textarea").addValue("_OK");
        await nativeKey("enter");
        await terminalContains("ITALIAN_èé_OK");
      });
    },
  );
});
