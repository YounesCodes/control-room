import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { App } from "../App";
import "../styles.css";
const savedLayout = vi.hoisted(() => ({ save: vi.fn(async () => {}) }));
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
      saveWorkspaceState: savedLayout.save,
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
  savedLayout.save.mockClear();
});

function mountApp() {
  container = document.createElement("div");
  container.style.height = "100vh";
  document.body.append(container);
  root = createRoot(container);
  root.render(<App />);
}

function paneBounds() {
  return Array.from(container!.querySelectorAll(".terminal-workspace-pane-visible"), (pane) =>
    pane.getBoundingClientRect(),
  );
}

async function split(direction: "vertically" | "horizontally") {
  await page.getByRole("button", { name: "Split terminal", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`Split ${direction}`) }).click();
  await page
    .getByRole("button", { name: "New local terminal: Command Prompt", exact: true })
    .click();
}
describe("Local Terminal Mode in the real App", () => {
  it("resizes every nested split, saves its sizes, and retains them across Focus Mode", async () => {
    await page.viewport(1280, 800);
    mountApp();
    await expect.element(page.getByRole("button", { name: "Exit terminal focus" })).toBeVisible();
    await split("vertically");
    await split("horizontally");
    const outer = page.getByRole("separator", { name: "Resize terminal split 1" });
    const inner = page.getByRole("separator", { name: "Resize terminal split 2" });
    await expect.element(inner).toHaveAttribute("aria-orientation", "horizontal");
    const initial = paneBounds();
    await userEvent.dragAndDrop(outer, container!.querySelector(".workspace-content")!, {
      sourcePosition: { x: 12, y: 100 },
      targetPosition: { x: 760, y: 100 },
    });
    await vi.waitFor(() => expect(paneBounds()[0].width).toBeGreaterThan(initial[0].width + 50));
    const afterOuter = paneBounds();
    await userEvent.dragAndDrop(inner, container!.querySelector(".workspace-content")!, {
      targetPosition: { x: 1000, y: 500 },
    });
    await vi.waitFor(() =>
      expect(paneBounds()[1].height).toBeGreaterThan(afterOuter[1].height + 50),
    );
    expect(paneBounds()[0].width).toBeCloseTo(afterOuter[0].width, 0);
    const selected = paneBounds();
    await vi.waitFor(() =>
      expect(savedLayout.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          terminalGroups: [
            expect.objectContaining({
              layout: expect.objectContaining({
                ratio: expect.any(Number),
                second: expect.objectContaining({ ratio: expect.any(Number) }),
              }),
            }),
          ],
        }),
      ),
    );
    const result = await axe.run(container!.querySelector<HTMLElement>(".workspace-content")!, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    expect(result.violations.map(({ id }) => id)).toEqual([]);
    await page.getByRole("button", { name: "Exit terminal focus" }).click();
    await expect.element(outer).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Focus terminal", exact: true }).click();
    await expect.element(inner).toBeVisible();
    await vi.waitFor(() => {
      expect(paneBounds()[0].width).toBeCloseTo(selected[0].width, 0);
      expect(paneBounds()[1].height).toBeCloseTo(selected[1].height, 0);
    });
    await inner.click();
    const beforeKey = paneBounds()[1].height;
    await userEvent.keyboard("{ArrowUp}");
    await vi.waitFor(() => expect(paneBounds()[1].height).toBeCloseTo(beforeKey - 10, 0));
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(paneBounds()[1].height).toBeCloseTo(paneBounds()[2].height, 0));
    await outer.dblClick({ position: { x: 12, y: 100 } });
    await vi.waitFor(() => expect(paneBounds()[0].width).toBeCloseTo(paneBounds()[1].width, 0));
  });
  it("resizes merged existing terminals and keeps each group's sizes independent", async () => {
    await page.viewport(960, 640);
    mountApp();
    await expect.element(page.getByRole("button", { name: "Exit terminal focus" })).toBeVisible();
    await page.getByRole("button", { name: "New terminal", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New terminal" })
      .getByRole("button", { name: /Command Prompt/ })
      .click();
    await page.getByRole("button", { name: "Split terminal", exact: true }).click();
    await page.getByRole("button", { name: /^Existing terminals:/ }).click();
    const divider = page.getByRole("separator", { name: "Resize terminal split 1" });
    await expect.element(divider).toBeVisible();
    const initial = Number(divider.element().getAttribute("aria-valuenow"));
    await divider.click();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await vi.waitFor(() =>
      expect(Number(divider.element().getAttribute("aria-valuenow"))).toBeCloseTo(initial + 50, 0),
    );
    // The existing terminal is the second tree leaf but the first mounted pane.
    await vi.waitFor(() => expect(paneBounds()[0].width).toBeCloseTo(initial - 50, 0));
    const selected = paneBounds()[0].width;
    const firstGroup = container!
      .querySelector<HTMLButtonElement>(".session-tab-group-main")!
      .getAttribute("aria-label")!;
    await page.getByRole("button", { name: "New terminal", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New terminal" })
      .getByRole("button", { name: /Command Prompt/ })
      .click();
    await expect.element(divider).not.toBeInTheDocument();
    await split("horizontally");
    await expect.element(divider).toHaveAttribute("aria-orientation", "horizontal");
    await divider.click();
    const secondSize = paneBounds()[0].height;
    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() =>
      expect(Math.abs(paneBounds()[0].height - secondSize - 10)).toBeLessThan(1),
    );
    const secondGroup = container!
      .querySelector<HTMLButtonElement>(".session-tab-group.active .session-tab-group-main")!
      .getAttribute("aria-label")!;
    await page.getByRole("button", { name: firstGroup, exact: true }).click();
    await expect.element(divider).toHaveAttribute("aria-orientation", "vertical");
    await vi.waitFor(() => expect(paneBounds()[0].width).toBeCloseTo(selected, 0));
    await page.getByRole("button", { name: secondGroup, exact: true }).click();
    await vi.waitFor(() =>
      expect(Math.abs(paneBounds()[0].height - secondSize - 10)).toBeLessThan(1),
    );
  });
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
