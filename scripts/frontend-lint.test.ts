import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: fileURLToPath(new URL("../", import.meta.url)) });
const component = "src/components/Example.tsx";

describe("frontend lint boundaries", () => {
  it.each([
    ["raw invoke", 'import { invoke } from "@tauri-apps/api/core"; void invoke("test");'],
    ["renamed invoke", 'export { invoke as dispatch } from "@tauri-apps/api/core";'],
    ["namespace import", 'import * as core from "@tauri-apps/api/core"; void core;'],
    ["Tauri package entry point", 'export * from "@tauri-apps/api";'],
    ["unapproved dialog method", 'export { save } from "@tauri-apps/plugin-dialog";'],
    ["alternate copy icon", 'export { CopyPlus } from "lucide-react";'],
  ])("rejects %s in app code", async (_name, code) => {
    const [result] = await eslint.lintText(code, { filePath: component });
    expect(result.messages.map(({ ruleId }) => ruleId)).toEqual(["no-restricted-imports"]);
  });

  it.each([
    [component, 'void import("@tauri-apps/api/core");', "no-restricted-syntax"],
    [component, "void import(`@tauri-apps/api/core`);", "no-restricted-syntax"],
    [component, 'window.__TAURI_INTERNALS__.invoke("test");', "no-restricted-globals"],
    [component, 'window["confirm"]("Continue?");', "no-restricted-globals"],
    [component, 'confirm("Continue?");', "no-restricted-globals"],
    [component, "export type Value = any;", "@typescript-eslint/no-explicit-any"],
    [
      "src/components/ReleaseNotes.tsx",
      'export const notes = <p dangerouslySetInnerHTML={{ __html: "notes" }} />;',
      "no-restricted-syntax",
    ],
    [component, 'import { Terminal } from "@xterm/xterm"; void Terminal;', "no-restricted-syntax"],
    [
      component,
      'import { FitAddon } from "@xterm/addon-fit"; void FitAddon;',
      "no-restricted-syntax",
    ],
    [
      "src/pages/LogsPane.tsx",
      'import { useAppUpdater } from "../hooks/use-app-updater"; void useAppUpdater;',
      "no-restricted-syntax",
    ],
    [
      component,
      'import { api } from "../lib/api"; void api.checkForUpdate();',
      "no-restricted-syntax",
    ],
    [
      "src/App.tsx",
      'import { api } from "./lib/api"; void api.installUpdate();',
      "no-restricted-syntax",
    ],
    [
      component,
      `import { Clipboard } from "lucide-react";
       export const copy = <button aria-label="Copy output"><Clipboard /></button>;`,
      "no-restricted-syntax",
    ],
    [
      component,
      `import { Clipboard } from "lucide-react";
       export const icon = <Clipboard />;`,
      "no-restricted-syntax",
    ],
  ])("rejects a prohibited construct in %s: %s", async (filePath, code, ruleId) => {
    const [result] = await eslint.lintText(code, { filePath });
    expect(result.messages.map((message) => message.ruleId)).toEqual([ruleId]);
  });

  it.each([
    [
      component,
      `import { api } from "../lib/api";
       import { Channel } from "@tauri-apps/api/core";
       import { listen } from "@tauri-apps/api/event";
       import { getCurrentWindow } from "@tauri-apps/api/window";
       import { open } from "@tauri-apps/plugin-dialog";
       export const load = () => api.listConnections();
       export { Channel, listen, getCurrentWindow, open };`,
    ],
    ["src/lib/api.ts", 'import { invoke } from "@tauri-apps/api/core"; void invoke("test");'],
    [
      "src/components/TerminalPane.tsx",
      `import { Terminal } from "@xterm/xterm";
       import { FitAddon } from "@xterm/addon-fit";
       export { Terminal, FitAddon };`,
    ],
    [
      "src/lib/terminal-screen.ts",
      'import type { Terminal } from "@xterm/xterm"; export type Screen = Terminal;',
    ],
    ["src/App.tsx", 'import { useAppUpdater } from "./hooks/use-app-updater"; void useAppUpdater;'],
    [
      "src/pages/SettingsPane.tsx",
      'import type { ManualCheckResult } from "../hooks/use-app-updater"; export type R = ManualCheckResult;',
    ],
    [
      "src/hooks/use-app-updater.ts",
      'import { api } from "../lib/api"; void api.checkForUpdate(); void api.installUpdate();',
    ],
    [
      component,
      `import { Clipboard } from "lucide-react";
       export const paste = <button aria-label="Paste into terminal" title="Paste"><Clipboard /></button>;`,
    ],
    [
      "src/components/Example.browser.test.tsx",
      `import { vi } from "vitest";
       vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
       export type MockPayload = any;`,
    ],
  ])("allows existing API patterns in %s", async (filePath, code) => {
    const [result] = await eslint.lintText(code, { filePath });
    expect(result.messages).toEqual([]);
  });
});
