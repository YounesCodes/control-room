// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  openDocumentation: vi.fn(),
  listConnections: vi.fn(),
  settingsContract: vi.fn(),
  environment: vi.fn(),
  workspaceState: vi.fn(),
  listConnectionGroups: vi.fn(),
  listConnectionTags: vi.fn(),
  listLocalShells: vi.fn(),
  saveWorkspaceState: vi.fn(),
  cachedCapabilities: vi.fn(),
  refreshCapabilities: vi.fn(),
  closeSession: vi.fn(),
  scratchpadNote: vi.fn(),
  saveScratchpadNote: vi.fn(),
  saveSettings: vi.fn(),
  currentAppVersion: vi.fn(),
  checkForUpdate: vi.fn(),
  pendingUpdateNotice: vi.fn(),
  dismissUpdateNotice: vi.fn(),
}));

vi.mock("./lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("./components/WindowControls", () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));

import { App } from "./App";
import type { AppSettings, LocalShellProfile, SettingsContract } from "./types";

const settings: AppSettings = {
  terminalFontFamily: "Cascadia Mono, Consolas, monospace",
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
  localTerminalMode: false,
  defaultLocalShellId: null,
};

const gitBash: LocalShellProfile = {
  id: "git-bash",
  label: "Git Bash",
  kind: "git-bash",
  elevated: false,
};

describe("Opening Settings", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    api.openDocumentation.mockResolvedValue(undefined);
    api.listConnections.mockResolvedValue([]);
    api.settingsContract.mockResolvedValue({
      current: settings,
      defaults: settings,
      logTailOptions: [50, 100, 200, 500, 1000],
    } satisfies SettingsContract);
    api.environment.mockResolvedValue({
      sshPath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      sshConfigPath: "C:\\Users\\test\\.ssh\\config",
      sshAgentAvailable: true,
      platformSupported: true,
    });
    api.workspaceState.mockResolvedValue({
      workspaces: [],
      activeWorkspaceId: null,
      terminalLayout: null,
    });
    api.listConnectionGroups.mockResolvedValue([]);
    api.listConnectionTags.mockResolvedValue([]);
    api.listLocalShells.mockResolvedValue({
      profiles: [gitBash],
      administratorStatus: "disabled",
    });
    api.saveSettings.mockResolvedValue(undefined);
    api.saveWorkspaceState.mockResolvedValue(undefined);
    api.cachedCapabilities.mockResolvedValue(null);
    api.refreshCapabilities.mockResolvedValue({});
    api.closeSession.mockResolvedValue(undefined);
    api.scratchpadNote.mockResolvedValue(null);
    api.currentAppVersion.mockResolvedValue("0.7.5");
    api.checkForUpdate.mockResolvedValue(null);
    api.pendingUpdateNotice.mockResolvedValue(null);
    api.dismissUpdateNotice.mockResolvedValue(undefined);
  });

  it("prevents repeated browser launches while a request is pending", async () => {
    let finish!: () => void;
    api.openDocumentation.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<App />);
    const docs = (await screen.findByRole("button", {
      name: "Open documentation",
    })) as HTMLButtonElement;
    act(() => {
      docs.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      docs.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(api.openDocumentation).toHaveBeenCalledTimes(1);
    expect(docs.disabled).toBe(true);
    expect(docs.getAttribute("aria-busy")).toBe("true");
    expect(docs.title).toBe("Opening documentation…");
    await user.click(docs);
    expect(api.openDocumentation).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(docs.disabled).toBe(false));
    expect(docs.getAttribute("aria-busy")).toBe("false");
    await user.click(docs);
    expect(api.openDocumentation).toHaveBeenCalledTimes(2);
  });

  it("keeps workspace errors when documentation succeeds, fails, is dismissed and retried", async () => {
    api.workspaceState.mockRejectedValueOnce("Workspace database unavailable");
    const user = userEvent.setup();
    render(<App />);
    const workspaceError = "Could not restore Workspaces: Workspace database unavailable";
    await screen.findByText(workspaceError);
    const docs = screen.getByRole("button", { name: "Open documentation" });
    await user.click(docs);
    expect(screen.getByText(workspaceError)).toBeTruthy();
    api.openDocumentation.mockRejectedValueOnce("Default browser unavailable");
    await user.click(docs);
    await screen.findByText("Could not open documentation: Default browser unavailable");
    expect(screen.getByText(workspaceError)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dismiss documentation error" }));
    expect(screen.getByText(workspaceError)).toBeTruthy();
    expect(
      screen.queryByText("Could not open documentation: Default browser unavailable"),
    ).toBeNull();
    await user.click(docs);
    expect(screen.getByText(workspaceError)).toBeTruthy();
  });

  it("opens documentation and keeps unsaved Settings changes when browser launch fails", async () => {
    const user = userEvent.setup();
    render(<App />);
    const docs = await screen.findByRole("button", { name: "Open documentation" });
    await user.click(docs);
    expect(api.openDocumentation).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Open Settings" }));
    await user.click(await screen.findByLabelText("Offer Git Bash"));
    api.openDocumentation.mockRejectedValueOnce("Default browser unavailable");
    await user.click(screen.getByRole("button", { name: "Open documentation" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Default browser unavailable");
    expect((screen.getByLabelText("Offer Git Bash") as HTMLInputElement).checked).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "Open documentation" }));
    expect(api.openDocumentation).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it("shows the pane with its local terminal toggles", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open Settings" }));

    expect(await screen.findByText("Local terminal", { selector: "legend" })).toBeTruthy();
    expect(screen.getByText("Terminal appearance", { selector: "legend" })).toBeTruthy();
    expect(screen.getByLabelText("Offer Git Bash")).toBeTruthy();
  });

  it("still opens when the settings payload predates the local terminal toggles", async () => {
    // An older backend, or a stored payload from before this setting existed,
    // simply has no such key. Settings has to open on that: the launchers read
    // the same list, and neither should fail over a missing optional field.
    const current = { ...settings } as AppSettings;
    delete (current as Partial<AppSettings>).hiddenLocalShells;
    api.settingsContract.mockResolvedValue({
      current,
      defaults: current,
      logTailOptions: [50, 100, 200, 500, 1000],
    } satisfies SettingsContract);

    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open Settings" }));

    expect(await screen.findByText("Local terminal", { selector: "legend" })).toBeTruthy();
    // Absent means offered, so the shell reads as on rather than crashing.
    const toggle = screen.getByLabelText("Offer Git Bash");
    expect(toggle).toBeTruthy();

    await user.click(toggle);
    const save = screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await user.click(save);
    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ hiddenLocalShells: ["git-bash"] }),
    );
  });

  it("renders with the payload and catalog this machine actually produces", async () => {
    // The real combination: sudo allowed globally, four installed shells with
    // their administrator variants, an agent with no identity, and the version
    // still resolving. Nothing here may take the pane down.
    api.settingsContract.mockResolvedValue({
      current: { ...settings, globalSudoEnabled: true },
      defaults: settings,
      logTailOptions: [50, 100, 200, 500, 1000],
    } satisfies SettingsContract);
    api.listLocalShells.mockResolvedValue({
      profiles: [
        { id: "powershell-7", label: "PowerShell 7", kind: "powershell-7", elevated: false },
        {
          id: "windows-powershell",
          label: "Windows PowerShell",
          kind: "windows-powershell",
          elevated: false,
        },
        { id: "command-prompt", label: "Command Prompt", kind: "command-prompt", elevated: false },
        { id: "git-bash", label: "Git Bash", kind: "git-bash", elevated: false },
        {
          id: "powershell-7-administrator",
          label: "PowerShell 7",
          kind: "powershell-7",
          elevated: true,
        },
        {
          id: "command-prompt-administrator",
          label: "Command Prompt",
          kind: "command-prompt",
          elevated: true,
        },
      ],
      administratorStatus: "available",
    });
    api.environment.mockResolvedValue({
      sshPath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      sshConfigPath: "C:\\Users\\X13\\.ssh\\config",
      sshAgentAvailable: false,
      platformSupported: true,
    });
    api.currentAppVersion.mockResolvedValue(null);

    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open Settings" }));

    expect(await screen.findByText("Local terminal", { selector: "legend" })).toBeTruthy();
    expect(screen.getByText("Run as administrator", { selector: "strong" })).toBeTruthy();
    expect(screen.getByLabelText("Offer Command Prompt, run as administrator")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
  });
});
