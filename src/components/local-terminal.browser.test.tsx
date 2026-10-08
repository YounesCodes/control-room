import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { App } from "../App";
import "../styles.css";
vi.mock("./WindowControls", () => ({ WindowControls: () => null }));
vi.mock("./TerminalPane", () => ({
  TerminalPane: () => (
    <div role="region" aria-label="Local terminal surface" style={{ height: "100%" }} />
  ),
}));
vi.mock("../lib/api", () => {
  const settings = {
    terminalFontFamily: "Consolas",
    terminalFontSize: 14,
    terminalScrollback: 10000,
    terminalForeground: "#f2f2ee",
    terminalRed: "#ff6f7d",
    terminalGreen: "#52cf91",
    terminalYellow: "#e8c56c",
    terminalBlue: "#55aef2",
    terminalMagenta: "#c793ff",
    terminalCyan: "#65d4d1",
    defaultLogTail: 200,
    globalHistoryEnabled: true,
    globalSudoEnabled: false,
    automaticUpdateChecks: false,
    hiddenLocalShells: [],
    localTerminalMode: true,
    defaultLocalShellId: null,
  };
  return {
    errorMessage: String,
    api: {
      listConnections: async () => [],
      settingsContract: async () => ({
        current: settings,
        defaults: settings,
        logTailOptions: [200],
      }),
      environment: async () => ({
        sshPath: null,
        sshConfigPath: "",
        sshAgentAvailable: false,
        platformSupported: true,
      }),
      workspaceState: async () => ({
        workspaces: [],
        activeWorkspaceId: null,
        terminalLayout: null,
      }),
      listConnectionGroups: async () => [],
      listConnectionTags: async () => [],
      listLocalShells: async () => ({
        profiles: [
          {
            id: "command-prompt",
            label: "Command Prompt",
            kind: "command-prompt",
            elevated: false,
          },
        ],
        administratorStatus: "disabled",
      }),
      saveWorkspaceState: async () => {},
      currentAppVersion: async () => "0.8.2",
      pendingUpdateNotice: async () => null,
    },
  };
});
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  root?.unmount();
  container?.remove();
});
describe("Local Terminal Mode in the real App", () => {
  it.each([960, 1280])(
    "starts in full-width focus and restores Connections on exit at %s pixels",
    async (width) => {
      await page.viewport(width, 640);
      container = document.createElement("div");
      container.style.height = "100vh";
      document.body.append(container);
      root = createRoot(container);
      root.render(<App />);
      await expect.element(page.getByRole("button", { name: "Exit terminal focus" })).toBeVisible();
      expect(container.querySelector(".app-shell")!.className).toBe(
        "app-shell terminal-focus-mode",
      );
      expect(getComputedStyle(container.querySelector(".sidebar")!).display).toBe("none");
      const shell = container.querySelector(".app-shell")!.getBoundingClientRect();
      const terminal = container.querySelector(".workspace-shell")!.getBoundingClientRect();
      expect(terminal.left).toBe(shell.left + 1);
      expect(terminal.right).toBe(shell.right - 1);
      await expect.element(page.getByRole("button", { name: "New terminal" })).toBeVisible();
      await expect
        .element(page.getByRole("region", { name: "Local terminal surface" }))
        .toBeVisible();
      const result = await axe.run(container, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      });
      expect(result.violations.map(({ id }) => id)).toEqual([]);
      await page.getByRole("button", { name: "Exit terminal focus" }).click();
      await expect
        .element(page.getByRole("button", { name: "Add connection", exact: true }))
        .toBeVisible();
      expect(container.querySelector(".app-shell")!.className).toBe("app-shell");
      await expect
        .element(page.getByRole("region", { name: "Local terminal surface" }))
        .toBeVisible();
    },
  );
});
