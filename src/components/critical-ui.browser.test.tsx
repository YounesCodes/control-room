import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { useState, type ReactNode } from "react";
import axe from "axe-core";
import { Modal } from "./Modal";
import { CommandPalette } from "./CommandPalette";
import { ConnectionDialog } from "./ConnectionDialog";
import { WindowControls } from "./WindowControls";
import { WorkspaceTabScroller } from "./WorkspaceTabScroller";
import { SettingsPane } from "../pages/SettingsPane";
import type { AppSettings, EnvironmentInfo } from "../types";
import "../styles.css";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(content: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  root.render(content);
}

async function expectAccessibleDialog() {
  const dialog = page.getByRole("dialog").element();
  for (const animation of dialog.parentElement?.getAnimations({ subtree: true }) ?? []) {
    if (animation.playState === "running") animation.finish();
  }
  const result = await axe.run(dialog, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
  });
  expect(
    result.violations.map(
      ({ id, nodes }) =>
        `${id}: ${nodes.map((node) => `${node.target}: ${node.failureSummary}`).join("; ")}`,
    ),
  ).toEqual([]);
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
});

function ModalFixture({ long = false }: { long?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      {open && (
        <Modal title="Example dialog" onClose={() => setOpen(false)}>
          <div className="form-stack">
            <label>
              Name <input />
            </label>
            {long &&
              Array.from({ length: 40 }, (_, index) => <p key={index}>Detail {index + 1}</p>)}
            <footer className="modal-actions">
              <button className="primary-button" type="button">
                Save
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </>
  );
}

function PaletteFixture({ onSettings }: { onSettings: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      {open && (
        <CommandPalette
          connections={[]}
          localShells={[]}
          workspaces={[]}
          activeWorkspaceId={null}
          activeView={null}
          canOpenNewTerminal={false}
          activeWorkspaceIsLocal={false}
          canFocusTerminal={false}
          canSplitTerminal={false}
          views={[]}
          hostCapabilities={{}}
          labelForWorkspace={() => ""}
          onClose={() => setOpen(false)}
          onOpenConnection={() => undefined}
          onOpenLocalShell={() => undefined}
          onSelectWorkspace={() => undefined}
          onSetView={() => undefined}
          onNewTerminal={() => undefined}
          onReconnect={() => undefined}
          onCloseWorkspace={() => undefined}
          onFocusTerminal={() => undefined}
          onFindTerminal={() => undefined}
          onSplitTerminal={() => undefined}
          onRenameWorkspace={() => undefined}
          onManageConnections={() => undefined}
          onAddConnection={() => undefined}
          onOpenSettings={onSettings}
          onCheckForUpdates={() => undefined}
        />
      )}
    </>
  );
}

const settings: AppSettings = {
  terminalFontFamily: "Consolas, monospace",
  terminalFontSize: 14,
  terminalScrollback: 10_000,
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
  automaticUpdateChecks: true,
  hiddenLocalShells: [],
};

const environment: EnvironmentInfo = {
  sshPath: null,
  sshConfigPath: "C:/Users/test/.ssh/config",
  sshAgentAvailable: false,
  platformSupported: true,
};

function SettingsFixture() {
  return (
    <SettingsPane
      settings={settings}
      defaults={settings}
      logTailOptions={[50, 100, 200, 500, 1000]}
      localShells={[]}
      environment={environment}
      appVersion="0.7.6"
      onCheckForUpdates={async () => ({ outcome: "current" })}
      onSaved={() => undefined}
      onClose={() => true}
      onDirtyChange={() => undefined}
    />
  );
}

function TabOverflowFixture() {
  const [active, setActive] = useState(0);
  const [count, setCount] = useState(4);
  const [narrow, setNarrow] = useState(false);
  const tabs = Array.from({ length: count }, (_, index) => index);
  return (
    <div style={{ width: narrow ? 340 : 740 }}>
      <nav className="session-tabs" aria-label="Open Workspaces">
        <WorkspaceTabScroller activeTabId={`tab-${active}`} arrangementKey={`count-${count}`}>
          {tabs.map((index) => (
            <div className={`session-tab-wrap ${index === active ? "active" : ""}`} key={index}>
              <button className="session-tab-main" type="button" onClick={() => setActive(index)}>
                Terminal {index + 1}
              </button>
            </div>
          ))}
        </WorkspaceTabScroller>
        <button className="session-new-terminal" type="button">
          New terminal
        </button>
      </nav>
      <button type="button" onClick={() => setNarrow((current) => !current)}>
        Resize tabs
      </button>
      <button
        type="button"
        onClick={() => {
          setActive(count);
          setCount(count + 1);
        }}
      >
        Add terminal
      </button>
      <button type="button" onClick={() => setActive(count - 1)}>
        Select last terminal
      </button>
      <button type="button" onClick={() => setActive(0)}>
        Select first terminal
      </button>
    </div>
  );
}

function TabNameFixture() {
  return (
    <div>
      <nav className="session-tabs" aria-label="Open Workspaces">
        <div className="session-tab-wrap active">
          <button
            className="session-tab-main"
            type="button"
            aria-label="Open production database workspace"
            title="Production database workspace"
          >
            <span className="session-tab-label">Production database workspace</span>
          </button>
          <button className="session-tab-rename" type="button" aria-label="Rename workspace">
            Edit
          </button>
          <button className="session-tab-close" type="button" aria-label="Close workspace">
            Close
          </button>
        </div>
        <div className="session-tab-wrap">
          <button className="session-tab-main" type="button">
            <span className="session-tab-label">Git Bash</span>
          </button>
          <button className="session-tab-rename" type="button" aria-label="Rename Git Bash">
            Edit
          </button>
          <button className="session-tab-close" type="button" aria-label="Close Git Bash">
            Close
          </button>
        </div>
      </nav>
      <button type="button">Outside</button>
    </div>
  );
}

describe("critical UI in Chromium", () => {
  it("gives active tab names the action space until hover or keyboard focus", async () => {
    mount(<TabNameFixture />);
    const main = page.getByRole("button", { name: "Open production database workspace" });
    await expect.element(main).toBeVisible();
    const tab = document.querySelector<HTMLElement>(".session-tab-wrap")!;
    const nextTab = document.querySelectorAll<HTMLElement>(".session-tab-wrap")[1];
    const label = document.querySelector<HTMLElement>(".session-tab-label")!;
    const rename = document.querySelector<HTMLButtonElement>(".session-tab-rename")!;
    const initialTabWidth = tab.getBoundingClientRect().width;
    const nextTabLeft = nextTab.getBoundingClientRect().left;
    const initialLabelWidth = label.getBoundingClientRect().width;
    expect(getComputedStyle(rename).opacity).toBe("0");

    await main.hover();
    await vi.waitFor(() => expect(Number(getComputedStyle(rename).opacity)).toBeGreaterThan(0.9));
    expect(label.getBoundingClientRect().width).toBeLessThan(initialLabelWidth - 40);
    expect(Math.abs(tab.getBoundingClientRect().width - initialTabWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs(nextTab.getBoundingClientRect().left - nextTabLeft)).toBeLessThanOrEqual(1);

    await page.getByRole("button", { name: "Outside" }).hover();
    await vi.waitFor(() => expect(getComputedStyle(rename).opacity).toBe("0"));
    rename.focus();
    await vi.waitFor(() => expect(Number(getComputedStyle(rename).opacity)).toBeGreaterThan(0.9));
  });

  it("keeps New terminal reachable and reveals tabs when the strip overflows", async () => {
    mount(<TabOverflowFixture />);
    await expect
      .element(page.getByRole("button", { name: "Scroll terminals right" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Add terminal" }).click();
    const list = document.querySelector<HTMLElement>(".session-tab-list")!;
    await expect
      .element(page.getByRole("button", { name: "Scroll terminals right" }))
      .toBeVisible();
    await vi.waitFor(() => {
      const selected = document.querySelector<HTMLElement>(".session-tab-wrap.active")!;
      expect(selected.getBoundingClientRect().right).toBeLessThanOrEqual(
        list.getBoundingClientRect().right + 1,
      );
    });

    await page.getByRole("button", { name: "Select first terminal" }).click();
    await page.getByRole("button", { name: "Resize tabs" }).click();
    await expect
      .element(page.getByRole("button", { name: "Scroll terminals right" }))
      .toBeVisible();
    expect(list.scrollWidth).toBeGreaterThan(list.clientWidth);
    await expect.element(page.getByRole("button", { name: "New terminal" })).toBeVisible();

    await page.getByRole("button", { name: "Scroll terminals right" }).click();
    await vi.waitFor(() => expect(list.scrollLeft).toBeGreaterThan(0));

    await page.getByRole("button", { name: "Select last terminal" }).click();
    await vi.waitFor(() => {
      const selected = document.querySelector<HTMLElement>(".session-tab-wrap.active")!;
      expect(selected.getBoundingClientRect().right).toBeLessThanOrEqual(
        list.getBoundingClientRect().right + 1,
      );
    });
    await expect.element(page.getByRole("button", { name: "New terminal" })).toBeVisible();
  });

  it("keeps the first visible terminal tab whole after scrolling right", async () => {
    await page.viewport(1024, 768);
    mount(<TabOverflowFixture />);
    await page.getByRole("button", { name: "Add terminal" }).click();
    await page.getByRole("button", { name: "Select first terminal" }).click();
    const list = document.querySelector<HTMLElement>(".session-tab-list")!;
    const right = page.getByRole("button", { name: "Scroll terminals right" });
    await right.click();
    await vi.waitFor(() => expect(list.scrollLeft).toBeGreaterThan(0));
    await right.click();
    await vi.waitFor(() => expect((right.element() as HTMLButtonElement).disabled).toBe(true));

    const edge = list.getBoundingClientRect().left;
    const firstVisible = Array.from(list.querySelectorAll<HTMLElement>(".session-tab-wrap")).find(
      (tab) => tab.getBoundingClientRect().right > edge + 1,
    )!;
    expect(firstVisible.getBoundingClientRect().left).toBeGreaterThanOrEqual(edge - 1);

    list.scrollLeft = 470;
    await vi.waitFor(() => expect(Math.abs(list.scrollLeft - 392)).toBeLessThanOrEqual(1));
    const wheelVisible = Array.from(list.querySelectorAll<HTMLElement>(".session-tab-wrap")).find(
      (tab) => tab.getBoundingClientRect().right > edge + 1,
    )!;
    expect(wheelVisible.getBoundingClientRect().left).toBeGreaterThanOrEqual(edge - 1);
  });

  it("traps dialog focus, closes on Escape, and restores the trigger", async () => {
    mount(<ModalFixture />);
    const trigger = page.getByRole("button", { name: "Open dialog" });
    await trigger.click();
    await expect.element(page.getByRole("dialog", { name: "Example dialog" })).toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "Name" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect.element(page.getByRole("button", { name: "Close" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect.element(page.getByRole("button", { name: "Save" })).toHaveFocus();
    await expectAccessibleDialog();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
  });

  it("keeps a long dialog's heading and actions visible while its body scrolls", async () => {
    await page.viewport(960, 640);
    mount(<ModalFixture long />);
    await page.getByRole("button", { name: "Open dialog" }).click();
    const dialog = page.getByRole("dialog").element();
    expect(dialog.scrollHeight).toBeGreaterThan(dialog.clientHeight);
    dialog.scrollTop = dialog.scrollHeight;
    expect(dialog.scrollTop).toBeGreaterThan(0);
    const bounds = dialog.getBoundingClientRect();
    const header = dialog.querySelector(".modal-header")!.getBoundingClientRect();
    const actions = dialog.querySelector(".modal-actions")!.getBoundingClientRect();
    expect(header.top).toBeGreaterThanOrEqual(bounds.top);
    expect(actions.bottom).toBeLessThanOrEqual(bounds.bottom);
    await expect.element(page.getByRole("button", { name: "Save" })).toBeVisible();
  });

  it("navigates the command palette with a real keyboard", async () => {
    const onSettings = vi.fn();
    mount(<PaletteFixture onSettings={onSettings} />);
    const trigger = page.getByRole("button", { name: "Open palette" });
    await trigger.click();
    const search = page.getByRole("combobox", { name: "Search commands" });
    await expect.element(search).toHaveFocus();
    await search.fill("settings");
    await expect.element(page.getByRole("option", { name: "Open settings" })).toBeVisible();
    await expectAccessibleDialog();
    await userEvent.keyboard("{Enter}");
    expect(onSettings).toHaveBeenCalledOnce();
    await expect.element(trigger).toHaveFocus();
  });

  it("keeps the connection form and native window controls named", async () => {
    mount(
      <>
        <ConnectionDialog
          groups={[]}
          knownTags={[]}
          globalSudoEnabled={false}
          onClose={() => undefined}
          onSaved={() => undefined}
        />
        <WindowControls
          windowActions={{
            close: async () => undefined,
            minimize: async () => undefined,
            toggleMaximize: async () => undefined,
          }}
        />
      </>,
    );
    await expect.element(page.getByRole("textbox", { name: "Display name" })).toHaveFocus();
    await expectAccessibleDialog();
    for (const name of ["Minimize window", "Maximize or restore window", "Close window"]) {
      await expect.element(page.getByRole("button", { name })).toHaveAccessibleName(name);
    }
  });

  it("keeps Settings actions visible at the minimum supported height", async () => {
    await page.viewport(960, 640);
    mount(<SettingsFixture />);
    await expect.element(page.getByRole("button", { name: "Close Settings" })).toBeVisible();
    const back = page.getByRole("button", { name: "Close Settings" }).element();
    const save = page.getByRole("button", { name: "Save settings" }).element();
    expect(back.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(save.getBoundingClientRect().bottom).toBeLessThanOrEqual(640);
    expect(save).toHaveAccessibleName("Save settings");
    const result = await axe.run(container!, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    expect(result.violations.map(({ id, nodes }) => `${id}: ${nodes.length} nodes`)).toEqual([]);
  });

  it("honors reduced motion while keeping dialog keyboard focus usable", async () => {
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    mount(<ModalFixture />);
    await page.getByRole("button", { name: "Open dialog" }).click();
    await expect.element(page.getByRole("dialog", { name: "Example dialog" })).toBeVisible();
    const modal = page.getByRole("dialog", { name: "Example dialog" }).element();
    expect(parseFloat(getComputedStyle(modal).animationDuration)).toBeLessThanOrEqual(0.00001);
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("button", { name: "Open dialog" })).toHaveFocus();
  });

  it("keeps Settings content bounded and centered in a wide window", async () => {
    await page.viewport(1600, 900);
    mount(<SettingsFixture />);
    await expect.element(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    const form = container!.querySelector(".settings-form")!.getBoundingClientRect();
    const heading = container!.querySelector(".settings-heading-inner")!.getBoundingClientRect();
    expect(form.width).toBeLessThan(1100);
    expect(Math.abs(form.left - (1600 - form.right))).toBeLessThan(24);
    expect(Math.abs(heading.left - form.left)).toBeLessThan(24);
    expect(Math.abs(heading.right - form.right)).toBeLessThan(24);
  });
});
