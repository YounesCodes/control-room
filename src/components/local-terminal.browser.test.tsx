import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { App } from "../App";
import { TooltipLayer } from "./TooltipLayer";
import "../styles.css";
const savedLayout = vi.hoisted(() => ({ save: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn() }),
}));
vi.mock("./TerminalPane", () => ({
  TerminalPane: () => (
    <div
      role="region"
      aria-label="Local terminal surface"
      style={{ height: "100%", background: "#050505", position: "relative" }}
    />
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
      scratchpadNote: async () => null,
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

function mountApp(withTooltips = false) {
  container = document.createElement("div");
  container.style.height = "100vh";
  document.body.append(container);
  root = createRoot(container);
  root.render(
    <>
      <App />
      {withTooltips && <TooltipLayer />}
    </>,
  );
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
  it.each([800, 1600])(
    "keeps individual pane controls separate from group actions at %s pixels",
    async (width) => {
      await page.viewport(width, 640);
      mountApp(true);
      await expect.element(page.getByRole("button", { name: "Exit terminal focus" })).toBeVisible();
      await split("vertically");
      await split("horizontally");
      // Pane tabs reveal Rename and Close exactly like every other tab: hidden
      // at rest, slid in by the hover (or keyboard focus) that also drags the
      // trailing session dot aside.
      const paneTabs = [
        ...container!.querySelectorAll<HTMLElement>(".session-pane-tabs .session-tab-wrap"),
      ];
      const controls = paneTabs.flatMap((tab) => [
        ...tab.querySelectorAll<HTMLButtonElement>(".session-tab-rename, .session-tab-close"),
      ]);
      expect(paneTabs.length).toBeGreaterThanOrEqual(3);
      expect(controls).toHaveLength(6);
      for (const control of controls) {
        expect(getComputedStyle(control).opacity).toBe("0");
      }
      await userEvent.hover(paneTabs[0]);
      const revealed = [
        ...paneTabs[0].querySelectorAll<HTMLButtonElement>(
          ".session-tab-rename, .session-tab-close",
        ),
      ];
      await vi.waitFor(() => {
        for (const control of revealed) {
          expect(Number(getComputedStyle(control).opacity)).toBeGreaterThan(0.9);
        }
      });
      for (const control of revealed) {
        const rect = control.getBoundingClientRect();
        expect(
          document
            .elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
            ?.closest("button"),
        ).toBe(control);
      }
      const groupButton = container!.querySelector<HTMLButtonElement>(".session-tab-group-main")!;
      await userEvent.hover(groupButton);
      await expect.element(page.getByRole("tooltip")).toBeVisible();
      expect(
        page.getByRole("tooltip").element().getBoundingClientRect().left,
      ).toBeGreaterThanOrEqual(8);
      // A pane tab's tools exist for the pointer only once the tab is hovered
      // or focused, so drive the pointer there like a user would first.
      const paneTabByLabel = (label: string) =>
        paneTabs.find((tab) => tab.querySelector(".session-tab-label")?.textContent === label)!;
      await userEvent.hover(paneTabByLabel("Command Prompt 2"));
      await page
        .getByRole("button", { name: "Rename Command Prompt 2 Workspace", exact: true })
        .click();
      await page.getByRole("textbox").fill("Background logs");
      await userEvent.keyboard("{Enter}");
      await expect
        .element(page.getByRole("button", { name: "Close Background logs Workspace" }))
        .toBeVisible();
      expect(
        container!.querySelector(".session-tab-wrap.active .session-tab-label")?.textContent,
      ).toBe("Command Prompt 3");
      await userEvent.hover(paneTabByLabel("Background logs"));
      await page.getByRole("button", { name: "Close Background logs Workspace" }).click();
      await expect
        .element(page.getByRole("button", { name: "Open Command Prompt group 2 terminals" }))
        .toBeVisible();
      expect(container!.querySelectorAll(".terminal-workspace-pane-visible")).toHaveLength(2);
      expect(
        container!.querySelector(".session-tab-wrap.active .session-tab-label")?.textContent,
      ).toBe("Command Prompt 2");
      await userEvent.hover(paneTabByLabel("Command Prompt 2"));
      await page.getByRole("button", { name: "Close Command Prompt 2 Workspace" }).click();
      expect(container!.querySelector(".session-pane-tabs")).toBeNull();
      await expect
        .element(page.getByRole("button", { name: "Command Prompt", exact: true }))
        .toHaveAttribute("aria-current", "page");
      await vi.waitFor(() =>
        expect(savedLayout.save).toHaveBeenLastCalledWith(
          expect.objectContaining({
            terminalGroups: [],
            workspaces: [expect.objectContaining({ label: null })],
          }),
        ),
      );
    },
  );

  it("paints the selected frame on all four edges above terminal contents in nested splits", async () => {
    await page.viewport(960, 641);
    mountApp();
    await expect.element(page.getByRole("button", { name: "Exit terminal focus" })).toBeVisible();
    await split("vertically");
    await split("horizontally");
    const tabs = [
      ...container!.querySelectorAll<HTMLButtonElement>(".session-pane-tabs .session-tab-main"),
    ];
    for (const [index, tab] of tabs.entries()) {
      await userEvent.click(tab);
      const pane = container!.querySelector<HTMLElement>(
        ".terminal-workspace-pane-visible.active",
      )!;
      const screenshot = await page.screenshot({
        element: pane,
        base64: true,
        path: `../../test-results/selected-pane-${index}.png`,
      });
      const bitmap = new Image();
      bitmap.src = `data:image/png;base64,${screenshot.base64}`;
      await bitmap.decode();
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!;
      context.fillStyle = getComputedStyle(pane).getPropertyValue("--accent").trim();
      context.fillRect(0, 0, 1, 1);
      const expected = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      context.drawImage(bitmap, 0, 0);
      const edges = {
        top: [Math.floor(bitmap.width / 2), 0],
        right: [bitmap.width - 1, Math.floor(bitmap.height / 2)],
        bottom: [Math.floor(bitmap.width / 2), bitmap.height - 1],
        left: [0, Math.floor(bitmap.height / 2)],
        topLeft: [0, 0],
        topRight: [bitmap.width - 1, 0],
        bottomLeft: [0, bitmap.height - 1],
        bottomRight: [bitmap.width - 1, bitmap.height - 1],
      };
      for (const [edge, [x, y]] of Object.entries(edges)) {
        const actual = [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
        expect(actual, `${tab.title}: ${edge} edge should show the selected frame`).toEqual(
          expected,
        );
      }
      const bounds = pane.getBoundingClientRect();
      // Stay clear of the split dividers' intentional mouse hit areas.
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + 30);
      expect(pane.contains(hit)).toBe(true);
      expect(hit, "The painted frame must leave terminal input clickable").not.toBe(pane);
    }
  });
  it.each([960, 1600])(
    "uses one tab per group and a keyboard-accessible pane row at %s pixels",
    async (width) => {
      await page.viewport(width, 640);
      mountApp();
      await expect.element(page.getByRole("button", { name: "Exit terminal focus" })).toBeVisible();
      await split("vertically");
      await split("horizontally");
      const strip = page.getByRole("navigation", { name: "Open Workspaces" }).element();
      expect(strip.querySelectorAll(".session-tab-group")).toHaveLength(1);
      expect(strip.querySelectorAll(".session-tab-wrap")).toHaveLength(0);
      const paneRow = container!.querySelector<HTMLElement>(".session-pane-tabs")!;
      expect(paneRow.querySelectorAll(".session-tab-wrap")).toHaveLength(3);
      await vi.waitFor(() =>
        expect(paneRow.querySelector(".session-tab-scroll-button")).toBeNull(),
      );
      const first = paneRow.querySelector<HTMLButtonElement>(".session-tab-main")!;
      first.focus();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() =>
        expect(paneRow.querySelector(".session-tab-wrap.active .session-tab-main")).toBe(first),
      );
      await page.getByRole("button", { name: /^Rename .* group$/ }).click();
      await page.getByRole("textbox").fill("Build and logs");
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: "Open Build and logs 3 terminals" }))
        .toBeVisible();
      const result = await axe.run(container!, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      });
      expect(
        result.violations.map(
          ({ id, nodes }) =>
            `${id}: ${nodes.map((node) => `${node.target}: ${node.failureSummary}`).join("; ")}`,
        ),
      ).toEqual([]);
      await page.screenshot({ path: `../../test-results/terminal-groups-${width}.png` });
      await page.getByRole("button", { name: "New terminal", exact: true }).click();
      await page
        .getByRole("dialog", { name: "New terminal" })
        .getByRole("button", { name: /Command Prompt/ })
        .click();
      expect(container!.querySelector(".session-pane-tabs")).toBeNull();
      await page.getByRole("button", { name: "Open Build and logs 3 terminals" }).click();
      expect(
        container!
          .querySelector(".session-pane-tabs .session-tab-wrap.active .session-tab-main")
          ?.getAttribute("title"),
      ).toBe(first.getAttribute("title"));
      await page
        .getByRole("button", { name: "Ungroup Build and logs; terminals stay open" })
        .click();
      await page.getByRole("button", { name: "Ungroup", exact: true }).click();
      expect(container!.querySelector(".session-pane-tabs")).toBeNull();
      const allTerminals = strip.querySelector<HTMLButtonElement>('[aria-label="All terminals"]');
      if (allTerminals) {
        await userEvent.click(allTerminals);
        expect(
          page
            .getByRole("menu", { name: "All terminals" })
            .element()
            .querySelectorAll('[role="menuitem"]'),
        ).toHaveLength(4);
        await userEvent.keyboard("{Escape}");
      } else {
        expect(strip.querySelectorAll(".session-tab-wrap")).toHaveLength(4);
      }
    },
  );
  it.each([800, 960, 1600])(
    "keeps a direct window drag target with overflowing tabs at %s pixels",
    async (width) => {
      await page.viewport(width, 640);
      mountApp();
      await expect.element(page.getByRole("button", { name: "Exit terminal focus" })).toBeVisible();
      for (let index = 0; index < 8; index++) {
        await page.getByRole("button", { name: "New terminal", exact: true }).click();
        await page
          .getByRole("dialog", { name: "New terminal" })
          .getByRole("button", { name: /Command Prompt/ })
          .click();
      }
      const drag = container!.querySelector<HTMLElement>(".session-window-drag-region");
      expect(drag, "Focus Mode needs a direct target to move the native window").not.toBeNull();
      const bounds = drag!.getBoundingClientRect();
      const strip = container!.querySelector(".session-tabs")!.getBoundingClientRect();
      const windowActions = container!
        .querySelector(".app-window-actions")!
        .getBoundingClientRect();
      expect(bounds.right).toBe(windowActions.left);
      expect(bounds.left).toBe(strip.left);
      expect(bounds.height).toBe(6);
      expect(bounds.top).toBe(strip.top);
      for (const fraction of [0.01, 0.5, 0.99]) {
        const hit = document.elementFromPoint(
          bounds.left + bounds.width * fraction,
          bounds.top + bounds.height / 2,
        );
        expect(hit).toBe(drag);
        expect(hit).toHaveAttribute("data-tauri-drag-region");
      }
      const focusToggle = page.getByRole("button", { name: "Exit terminal focus" }).element();
      const toggleBounds = focusToggle.getBoundingClientRect();
      expect(
        document
          .elementFromPoint(toggleBounds.left + toggleBounds.width / 2, bounds.top + 3)
          ?.closest("button"),
      ).toBe(focusToggle);
      const newTerminal = container!
        .querySelector(".session-new-terminal")!
        .getBoundingClientRect();
      const find = container!
        .querySelector('[aria-label="Find in terminal"]')!
        .getBoundingClientRect();
      expect(find.left - newTerminal.right).toBeLessThanOrEqual(1);
      // Strip buttons own the window's top edge so their hover fills the full
      // header height; the overlay drag strip stays the hit target above them.
      expect(newTerminal.top).toBe(strip.top);
      expect(find.top).toBe(strip.top);
      const scrollBack = container!
        .querySelector('[aria-label="Scroll terminals left"]')!
        .getBoundingClientRect();
      expect(scrollBack.top).toBe(strip.top);
      // Tabs fill the header's full height too, so their highlight reaches
      // the top edge under the drag overlay.
      const firstTab = container!.querySelector(
        ".session-tab-content > .session-tab-wrap, .session-tab-content > .session-tab-group",
      ) as HTMLElement | null;
      expect(firstTab?.getBoundingClientRect().top).toBe(strip.top);
      expect(
        container!.querySelector(".session-tab-main")!.hasAttribute("data-tauri-drag-region"),
      ).toBe(false);
      await expect
        .element(page.getByRole("button", { name: "Scroll terminals left" }))
        .toBeVisible();
    },
  );
  it("keeps the New terminal plus and chevron clustered as one control beside the picker", async () => {
    await page.viewport(1200, 640);
    mountApp();
    await expect.element(page.getByRole("button", { name: "Exit terminal focus" })).toBeVisible();
    for (let index = 0; index < 8; index++) {
      await page.getByRole("button", { name: "New terminal", exact: true }).click();
      await page
        .getByRole("dialog", { name: "New terminal" })
        .getByRole("button", { name: /Command Prompt/ })
        .click();
    }
    const control = container!.querySelector(".session-new-terminal") as HTMLElement;
    const [plus, menuChevron] = control.querySelectorAll<SVGSVGElement>("svg");
    const plusBox = plus.getBoundingClientRect();
    const chevronBox = menuChevron.getBoundingClientRect();
    const picker = container!
      .querySelector('[aria-label="All terminals"] svg')!
      .getBoundingClientRect();
    // The two glyphs sit far closer to each other than to any neighboring
    // control, so the pair reads as one button rather than two fused ones.
    const innerGap = chevronBox.left - plusBox.right;
    expect(innerGap).toBeLessThanOrEqual(4);
    expect(plusBox.left - picker.right).toBeGreaterThan(innerGap * 2);
    // The chevron is the control's menu affordance: quieter than the plus and
    // smaller than the neighboring All-terminals picker chevron.
    expect(getComputedStyle(menuChevron).color).not.toBe(getComputedStyle(plus).color);
    expect(chevronBox.height).toBeLessThan(picker.height);
  });
  it("anchors the Scratchpad popup over the terminal without reflowing the action strip", async () => {
    await page.viewport(1200, 640);
    mountApp();
    await expect.element(page.getByRole("button", { name: "Exit terminal focus" })).toBeVisible();
    const stripBefore = container!.querySelector(".session-tabs")!.getBoundingClientRect();
    await page.getByRole("button", { name: "Scratchpad" }).click();
    const dialog = page.getByRole("dialog", { name: "Scratchpad" });
    await expect.element(dialog).toBeVisible();
    // An anchored overlay: the strip that opened it neither moves nor resizes.
    const stripAfter = container!.querySelector(".session-tabs")!.getBoundingClientRect();
    expect(stripAfter.top).toBe(stripBefore.top);
    expect(stripAfter.height).toBe(stripBefore.height);
    const popover = dialog.element().getBoundingClientRect();
    expect(popover.top).toBeGreaterThanOrEqual(stripAfter.bottom);
    // A gutter keeps the popover's border readable instead of merging with
    // the window's.
    expect(window.innerWidth - popover.right).toBeGreaterThanOrEqual(4);
    expect(popover.width).toBeLessThanOrEqual(370);
    // Opens on the terminal's context, driven entirely from the keyboard.
    await expect.element(page.getByRole("textbox", { name: "Terminal note" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("button", { name: "Scratchpad" })).toHaveFocus();
    // Escape unmounts the popover after its shared closing transition, not
    // merely hiding it.
    expect(container!.querySelector(".scratchpad-popover")?.hasAttribute("data-closing")).toBe(
      true,
    );
    await vi.waitFor(() => expect(container!.querySelector(".scratchpad-popover")).toBeNull());
  });
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
