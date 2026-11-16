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
