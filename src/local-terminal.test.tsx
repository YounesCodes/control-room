// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
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
}));

vi.mock("./lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("./components/WindowControls", () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));

/// Stands in for the real terminal. It reports which target it was handed and
/// whether it was asked to start, and lets a test drive the session state the
/// way a live session would.
vi.mock("./components/TerminalPane", () => ({
  TerminalPane: ({
    workspace,
    onState,
    onSession,
  }: {
    workspace: {
      id: string;
      kind: string;
      connectRequested: boolean;
      sessionId: string | null;
      shell?: { id: string };
      connectionId?: string;
    };
    onState: (state: string, reason: string | null) => void;
    onSession: (sessionId: string | null) => void;
  }) => (
    <div
      data-testid={`terminal-${workspace.id}`}
      data-kind={workspace.kind}
      data-target={workspace.kind === "local" ? workspace.shell?.id : workspace.connectionId}
      data-connect-requested={String(workspace.connectRequested)}
      data-session={String(workspace.sessionId)}
    >
      <button type="button" onClick={() => onState("connected", null)}>
        report connected
      </button>
      <button type="button" onClick={() => onSession(`${workspace.id}-session`)}>
        report session
      </button>
    </div>
  ),
}));

import { App } from "./App";
import type {
  AppSettings,
  LocalShellProfile,
  PersistedWorkspaceState,
  SavedConnection,
} from "./types";

const settings: AppSettings = {
  terminalFontFamily: "Consolas",
  terminalFontSize: 14,
  terminalScrollback: 10_000,
  terminalRightClickPaste: false,
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
};

const powershell: LocalShellProfile = {
  id: "powershell-7",
  label: "PowerShell 7",
  kind: "powershell-7",
};
const gitBash: LocalShellProfile = {
  id: "git-bash",
  label: "Git Bash",
  kind: "git-bash",
};

function connection(id: string, displayName: string): SavedConnection {
  return {
    id,
    displayName,
    destination: displayName,
    username: "user",
    port: null,
    identityFile: null,
    historyEnabled: false,
    sudoEnabled: false,
    groupId: null,
    tags: [],
    createdAt: "",
    updatedAt: "",
    lastConnectedAt: null,
  };
}

const emptyState: PersistedWorkspaceState = {
  workspaces: [],
  activeWorkspaceId: null,
  terminalLayout: null,
};

async function openLocalShell(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(await screen.findByRole("button", { name: /Local terminal/ }));
  await user.click(await screen.findByRole("menuitem", { name: label }));
}

/// Clicks a Saved Connection in the sidebar. Its row also carries an actions
/// button, so this takes the first match, which is the row itself.
async function openConnection(user: ReturnType<typeof userEvent.setup>, name: string) {
  const sidebar = await screen.findByLabelText("Saved connections");
  await user.click(within(sidebar).getAllByRole("button", { name: new RegExp(name) })[0]);
}

describe("Local Terminal", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    api.listConnections.mockResolvedValue([]);
    api.settingsContract.mockResolvedValue({
      current: settings,
      defaults: settings,
      logTailOptions: [50, 100, 200, 500, 1000],
    });
    api.environment.mockResolvedValue({
      sshPath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      sshConfigPath: "C:\\Users\\test\\.ssh\\config",
      sshAgentAvailable: true,
      platformSupported: true,
    });
    api.workspaceState.mockResolvedValue(emptyState);
    api.listConnectionGroups.mockResolvedValue([]);
    api.listConnectionTags.mockResolvedValue([]);
    api.listLocalShells.mockResolvedValue([powershell, gitBash]);
    api.saveWorkspaceState.mockResolvedValue(undefined);
    api.cachedCapabilities.mockResolvedValue(null);
    api.refreshCapabilities.mockResolvedValue({});
    api.closeSession.mockResolvedValue(undefined);
    api.scratchpadNote.mockResolvedValue(null);
  });

  it("offers only the shells the machine actually has", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Local terminal/ }));

    expect(screen.getByRole("menuitem", { name: "PowerShell 7" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Git Bash" })).toBeTruthy();
    // Windows PowerShell and Command Prompt were not detected on this machine.
    expect(screen.queryByRole("menuitem", { name: "Windows PowerShell" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Command Prompt" })).toBeNull();
  });

  it("hides the launcher when no supported shell was detected", async () => {
    api.listLocalShells.mockResolvedValue([]);
    render(<App />);

    expect(await screen.findByRole("heading", { name: /No connections yet/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Local terminal/ })).toBeNull();
  });

  it("opens a local shell as its own Workspace without a Saved Connection", async () => {
    const user = userEvent.setup();
    render(<App />);

    await openLocalShell(user, "PowerShell 7");

    const terminal = await screen.findByTestId(/^terminal-/);
    expect(terminal.dataset.kind).toBe("local");
    expect(terminal.dataset.target).toBe("powershell-7");
    expect(terminal.dataset.connectRequested).toBe("true");
    expect(screen.getByRole("button", { name: /Close PowerShell 7 Workspace/ })).toBeTruthy();
    // No Saved Connection was invented for it: the sidebar list is still empty.
    expect(screen.getByText("No connections yet")).toBeTruthy();
  });

  it("keeps a local Workspace terminal-only", async () => {
    const user = userEvent.setup();
    const host = connection("11111111-1111-4111-8111-111111111111", "prod-web");
    api.listConnections.mockResolvedValue([host]);
    render(<App />);

    await openLocalShell(user, "Git Bash");

    // None of the Remote Host views are offered for a local shell.
    for (const view of [
      "Overview",
      "Systemd",
      "Ports",
      "Docker",
      "Boot",
      "Logs",
      "Baselines",
      "History",
      "Scratchpad",
    ]) {
      expect(screen.queryByRole("button", { name: view })).toBeNull();
    }

    // Opening the Saved Connection brings them back.
    await openConnection(user, "prod-web");
    expect(await screen.findByRole("button", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Systemd" })).toBeTruthy();
  });

  it("never runs host capability discovery for a local shell", async () => {
    const user = userEvent.setup();
    const host = connection("11111111-1111-4111-8111-111111111111", "prod-web");
    api.listConnections.mockResolvedValue([host]);
    render(<App />);

    await openLocalShell(user, "PowerShell 7");
    const localTerminal = await screen.findByTestId(/^terminal-/);
    // The local shell reports itself running, exactly as a live session would.
    await user.click(within(localTerminal).getByText("report connected"));

    expect(api.refreshCapabilities).not.toHaveBeenCalled();
    expect(api.cachedCapabilities).not.toHaveBeenCalledWith("powershell-7");

    // A Remote Host reporting the same state does discover its capabilities,
    // which is what makes the silence above a decision rather than an accident.
    await openConnection(user, "prod-web");
    const remoteTerminal = screen.getAllByTestId(/^terminal-/)[1];
    await user.click(within(remoteTerminal).getByText("report connected"));

    await waitFor(() => expect(api.refreshCapabilities).toHaveBeenCalledWith(host.id));
  });

  it("runs local and SSH Workspaces side by side", async () => {
    const user = userEvent.setup();
    const host = connection("11111111-1111-4111-8111-111111111111", "prod-web");
    api.listConnections.mockResolvedValue([host]);
    render(<App />);

    await openConnection(user, "prod-web");
    await openLocalShell(user, "PowerShell 7");

    const terminals = screen.getAllByTestId(/^terminal-/);
    expect(terminals.map((terminal) => terminal.dataset.kind)).toEqual(["remote", "local"]);
    expect(screen.getByRole("button", { name: /Close prod-web Workspace/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Close PowerShell 7 Workspace/ })).toBeTruthy();
  });

  it("opens another terminal of the same shell from a local Workspace", async () => {
    const user = userEvent.setup();
    render(<App />);

    await openLocalShell(user, "Git Bash");
    await user.click(screen.getByRole("button", { name: /New terminal/ }));

    const terminals = await screen.findAllByTestId(/^terminal-/);
    expect(terminals.map((terminal) => terminal.dataset.target)).toEqual(["git-bash", "git-bash"]);
    // The second tab is numbered against the first, as remote Workspaces are.
    expect(screen.getByRole("button", { name: /Close Git Bash 2 Workspace/ })).toBeTruthy();
  });

  it("splits a local shell beside an SSH terminal", async () => {
    const user = userEvent.setup();
    const host = connection("11111111-1111-4111-8111-111111111111", "prod-web");
    api.listConnections.mockResolvedValue([host]);
    render(<App />);

    await openConnection(user, "prod-web");
    await user.click(await screen.findByLabelText("Focus terminal"));
    await user.click(await screen.findByLabelText("Split terminal"));
    await user.click(await screen.findByRole("button", { name: "PowerShell 7" }));

    const terminals = await screen.findAllByTestId(/^terminal-/);
    expect(terminals.map((terminal) => terminal.dataset.kind)).toEqual(["remote", "local"]);
    // Both panes are laid out in the split, each labelled by its own target.
    const paneLabels = document.querySelectorAll(".terminal-pane-label");
    expect([...paneLabels].map((label) => label.textContent)).toEqual(["prod-web", "PowerShell 7"]);
  });

  it("restores a local tab without starting its shell", async () => {
    api.workspaceState.mockResolvedValue({
      workspaces: [
        {
          id: "workspace-local",
          label: null,
          connectionId: null,
          localShellId: "powershell-7",
          view: "terminal",
          historyPaused: false,
        },
      ],
      activeWorkspaceId: "workspace-local",
      terminalLayout: { kind: "leaf", workspaceId: "workspace-local" },
    });
    render(<App />);

    const terminal = await screen.findByTestId("terminal-workspace-local");

    expect(terminal.dataset.kind).toBe("local");
    expect(terminal.dataset.target).toBe("powershell-7");
    // Restored means present, not running.
    expect(terminal.dataset.connectRequested).toBe("false");
  });

  it("stops one local shell without touching the others", async () => {
    const user = userEvent.setup();
    render(<App />);

    await openLocalShell(user, "PowerShell 7");
    await openLocalShell(user, "Git Bash");
    const [powershellTerminal, bashTerminal] = screen.getAllByTestId(/^terminal-/);
    // Both shells report a live session.
    for (const terminal of [powershellTerminal, bashTerminal]) {
      await user.click(within(terminal).getByText("report session"));
    }
    await waitFor(() => expect(bashTerminal.dataset.session).not.toBe("null"));
    expect(powershellTerminal.dataset.session).not.toBe("null");

    await user.click(screen.getByRole("button", { name: /Close Git Bash Workspace/ }));
    // A running shell is confirmed in local words before it is stopped.
    expect(screen.getByText("Stop the local shell and close this Workspace?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Stop & close" }));

    await waitFor(() => expect(screen.queryByTestId(bashTerminal.dataset.testid!)).toBeNull());
    expect(api.closeSession).toHaveBeenCalledTimes(1);
    expect(api.closeSession).toHaveBeenCalledWith(
      `${bashTerminal.dataset.testid!.slice(9)}-session`,
    );
    // The other local terminal is untouched.
    expect(screen.getByTestId(powershellTerminal.dataset.testid!)).toBeTruthy();
  });

  it("closes a restored local tab without asking, because nothing is running", async () => {
    const user = userEvent.setup();
    api.workspaceState.mockResolvedValue({
      workspaces: [
        {
          id: "workspace-local",
          label: null,
          connectionId: null,
          localShellId: "git-bash",
          view: "terminal",
          historyPaused: false,
        },
      ],
      activeWorkspaceId: "workspace-local",
      terminalLayout: null,
    });
    render(<App />);
    await screen.findByTestId("terminal-workspace-local");

    await user.click(screen.getByRole("button", { name: /Close Git Bash Workspace/ }));

    await waitFor(() => expect(screen.queryByTestId("terminal-workspace-local")).toBeNull());
    expect(api.closeSession).not.toHaveBeenCalled();
  });

  it("persists local tabs by shell profile id", async () => {
    const user = userEvent.setup();
    render(<App />);

    await openLocalShell(user, "PowerShell 7");

    // Saving is debounced, so this waits for the write that carries the tab.
    await waitFor(() => {
      const [state] = api.saveWorkspaceState.mock.calls.at(-1) as [PersistedWorkspaceState];
      expect(state.workspaces).toHaveLength(1);
      expect(state.workspaces[0].localShellId).toBe("powershell-7");
      expect(state.workspaces[0].connectionId).toBeNull();
    });
  });
});
