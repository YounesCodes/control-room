import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { useState, type ReactNode } from "react";
import axe from "axe-core";
import { Modal } from "./Modal";
import { CommandPalette } from "./CommandPalette";
import { ConnectionDialog } from "./ConnectionDialog";
import { WindowControls } from "./WindowControls";
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

function ModalFixture() {
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
          workspaces={[]}
          activeWorkspaceId={null}
          activeView={null}
          canOpenNewTerminal={false}
          activeWorkspaceIsLocal={false}
          canFocusTerminal={false}
          views={[]}
          hostCapabilities={{}}
          labelForWorkspace={() => ""}
          onClose={() => setOpen(false)}
          onOpenConnection={() => undefined}
          onSelectWorkspace={() => undefined}
          onSetView={() => undefined}
          onNewTerminal={() => undefined}
          onReconnect={() => undefined}
          onCloseWorkspace={() => undefined}
          onFocusTerminal={() => undefined}
          onAddConnection={() => undefined}
          onOpenSettings={onSettings}
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
};

const environment: EnvironmentInfo = {
  sshPath: null,
  sshConfigPath: "C:/Users/test/.ssh/config",
  sshAgentAvailable: false,
  platformSupported: true,
};

describe("critical UI in Chromium", () => {
  it("traps dialog focus, closes on Escape, and restores the trigger", async () => {
    mount(<ModalFixture />);
    const trigger = page.getByRole("button", { name: "Open dialog" });
    await trigger.click();
    await expect.element(page.getByRole("dialog", { name: "Example dialog" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Close" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect.element(page.getByRole("button", { name: "Save" })).toHaveFocus();
    await expectAccessibleDialog();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
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
    mount(
      <SettingsPane
        settings={settings}
        defaults={settings}
        logTailOptions={[50, 100, 200, 500, 1000]}
        environment={environment}
        appVersion="0.7.6"
        onCheckForUpdates={async () => ({ outcome: "current" })}
        onSaved={() => undefined}
        onClose={() => true}
        onDirtyChange={() => undefined}
      />,
    );
    await expect.element(page.getByRole("button", { name: "Back to terminal" })).toBeVisible();
    const back = page.getByRole("button", { name: "Back to terminal" }).element();
    const save = page.getByRole("button", { name: "Save settings" }).element();
    expect(back.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(save.getBoundingClientRect().bottom).toBeLessThanOrEqual(640);
    expect(save).toHaveAccessibleName("Save settings");
    const result = await axe.run(container!, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    expect(result.violations.map(({ id, nodes }) => `${id}: ${nodes.length} nodes`)).toEqual([]);
  });
});
