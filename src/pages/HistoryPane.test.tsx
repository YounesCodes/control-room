// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  history: vi.fn(),
  historyIntegrationStatus: vi.fn(),
  installHistoryIntegration: vi.fn(),
  uninstallHistoryIntegration: vi.fn(),
  setConnectionHistoryEnabled: vi.fn(),
  deleteHistory: vi.fn(),
  clearHistory: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { HistoryPane } from "./HistoryPane";
import { notifyHistoryChanged } from "../lib/history-events";
import type { HistoryIntegrationStatus, SavedConnection } from "../types";

const connection: SavedConnection = {
  id: "connection-a",
  displayName: "Host A",
  destination: "host-a",
  username: "user",
  port: null,
  identityFile: null,
  historyEnabled: true,
  sudoEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

const historyEntry = {
  id: "entry-a",
  connectionId: connection.id,
  sessionId: "session-a",
  command: "docker ps",
  cwd: "/srv",
  startedAt: "2026-08-27T10:00:00Z",
  finishedAt: "2026-08-27T10:00:01Z",
  exitCode: 0,
  shell: "bash",
};

const MENU_ACTIONS = new Set([
  "Clear saved history",
  "Disable on this connection",
  "Enable on this connection",
  "Remove from remote Bash",
]);

async function clickAction(name: string) {
  if (MENU_ACTIONS.has(name)) {
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name }));
  } else {
    await userEvent.click(screen.getByRole("button", { name }));
  }
}

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

afterEach(cleanup);
function props() {
  return {
    connection,
    paused: false,
    globalEnabled: true,
    onPausedChange: vi.fn(),
    onConnectionChanged: vi.fn(),
    onPaste: vi.fn(),
    canPaste: true,
  };
}

describe("HistoryPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.history.mockResolvedValue([{ ...historyEntry }]);
    api.historyIntegrationStatus.mockRejectedValue(new Error("Host is offline"));
  });

  it("refreshes the active search when this connection saves a command", async () => {
    const user = userEvent.setup();
    render(<HistoryPane {...props()} />);
    await screen.findByText("docker ps");
    await user.type(screen.getByRole("textbox", { name: "Search commands" }), "docker");
    await waitFor(() => expect(api.history).toHaveBeenLastCalledWith(connection.id, "docker"));
    api.history.mockResolvedValue([
      { ...historyEntry, id: "new-entry", command: "docker stats" },
      historyEntry,
    ]);
    const readCount = api.history.mock.calls.length;
    notifyHistoryChanged("other-host");
    expect(api.history).toHaveBeenCalledTimes(readCount);
    notifyHistoryChanged(connection.id);
    await screen.findByText("stats");
    expect(api.history).toHaveBeenLastCalledWith(connection.id, "docker");
    expect(api.historyIntegrationStatus).toHaveBeenCalledTimes(1);
  });

  it("retains saved commands after clear fails and retries the confirmed operation", async () => {
    api.clearHistory
      .mockRejectedValueOnce(new Error("database locked"))
      .mockImplementationOnce(async () => {
        api.history.mockResolvedValue([]);
      });
    render(<HistoryPane {...props()} />);
    await screen.findByText("docker ps");
    await clickAction("Clear saved history");
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    await screen.findByText("database locked");
    expect(screen.getByText("docker ps")).toBeTruthy();
    await clickAction("Clear saved history");
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    await waitFor(() => expect(screen.queryByText("docker ps")).toBeNull());
  });

  it("reports integration installation failure without enabling capture and allows retry", async () => {
    api.historyIntegrationStatus.mockResolvedValue("not-installed");
    api.installHistoryIntegration
      .mockRejectedValueOnce(new Error("remote home is read-only"))
      .mockResolvedValue(connection);
    const options = props();
    render(<HistoryPane {...options} />);
    await userEvent.click(await screen.findByRole("button", { name: "Enable Enhanced History" }));
    await screen.findByText("remote home is read-only");
    expect(options.onConnectionChanged).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Enable Enhanced History" }));
    await waitFor(() => expect(options.onConnectionChanged).toHaveBeenCalledWith(connection));
  });

  it("updates an older Bash integration without enabling a disabled connection", async () => {
    const options = props();
    const disabled = { ...connection, historyEnabled: false };
    api.historyIntegrationStatus.mockResolvedValue("update-available");
    api.installHistoryIntegration.mockResolvedValue(disabled);
    render(<HistoryPane {...options} connection={disabled} />);
    await userEvent.click(await screen.findByRole("button", { name: "Update Bash integration" }));
    expect(api.installHistoryIntegration).toHaveBeenCalledExactlyOnceWith(connection.id, false);
    expect(options.onConnectionChanged).toHaveBeenCalledExactlyOnceWith(disabled);
    await screen.findByText("Disabled for this connection");
  });

  it("keeps local commands searchable when the remote integration check fails", async () => {
    const user = userEvent.setup();
    render(
      <HistoryPane
        connection={connection}
        paused={false}
        globalEnabled
        onPausedChange={vi.fn()}
        onConnectionChanged={vi.fn()}
        onPaste={vi.fn()}
        canPaste={false}
      />,
    );

    expect(await screen.findByText("docker ps")).toBeTruthy();
    expect(screen.getByText(/could not check the remote Bash integration/i)).toBeTruthy();

    await user.type(screen.getByPlaceholderText("Search commands"), "dock");
    await waitFor(() => {
      expect(api.history).toHaveBeenLastCalledWith(connection.id, "dock");
    });
    expect(api.historyIntegrationStatus).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Paste into terminal" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("pastes the exact saved command without executing it", async () => {
    const options = props();
    render(<HistoryPane {...options} />);
    await screen.findByText("docker ps");
    await userEvent.click(screen.getByRole("button", { name: "Paste into terminal" }));
    expect(options.onPaste).toHaveBeenCalledExactlyOnceWith("docker ps");
    expect(api.installHistoryIntegration).not.toHaveBeenCalled();
  });

  it("keeps history when clear is cancelled and removes it only after confirmation", async () => {
    api.clearHistory.mockImplementationOnce(async () => {
      api.history.mockResolvedValue([]);
    });
    render(<HistoryPane {...props()} />);
    await screen.findByText("docker ps");
    await clickAction("Clear saved history");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.clearHistory).not.toHaveBeenCalled();
    expect(screen.getByText("docker ps")).toBeTruthy();
    await clickAction("Clear saved history");
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    await waitFor(() => expect(screen.queryByText("docker ps")).toBeNull());
    expect(api.clearHistory).toHaveBeenCalledExactlyOnceWith(connection.id);
  });

  it("discards an in-flight read after clearing and shows commands saved after the clear", async () => {
    render(<HistoryPane {...props()} />);
    await screen.findByText("docker ps");
    let finishRead!: (entries: (typeof historyEntry)[]) => void;
    api.history.mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve)));
    notifyHistoryChanged(connection.id);
    await waitFor(() => expect(finishRead).toBeDefined());
    api.clearHistory.mockImplementationOnce(async () => {
      api.history.mockResolvedValue([{ ...historyEntry, id: "post-clear", command: "pwd" }]);
    });
    await clickAction("Clear saved history");
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    await act(async () => finishRead([historyEntry]));
    await screen.findByText("pwd");
    expect(screen.queryByText("docker ps")).toBeNull();
  });

  it("keeps the entry visible when deletion fails and allows a retry", async () => {
    api.deleteHistory
      .mockRejectedValueOnce(new Error("SQLite is busy"))
      .mockResolvedValue(undefined);
    render(<HistoryPane {...props()} />);
    await screen.findByText("docker ps");
    await userEvent.click(screen.getByRole("button", { name: "Delete history entry" }));
    expect(await screen.findByText("SQLite is busy")).toBeTruthy();
    expect(screen.getByText("docker ps")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Delete history entry" }));
    await waitFor(() => expect(screen.queryByText("docker ps")).toBeNull());
  });

  it("reports an empty integrated history separately from a failed history read", async () => {
    api.history.mockResolvedValue([]);
    api.historyIntegrationStatus.mockResolvedValue("installed");
    render(<HistoryPane {...props()} />);
    expect(await screen.findByText("No commands recorded yet")).toBeTruthy();
    api.history.mockRejectedValue(new Error("Read failed"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Read failed")).toBeTruthy();
    expect(screen.queryByText("No commands recorded yet")).toBeNull();
  });

  it("keeps existing commands available when global recording is disabled", async () => {
    render(<HistoryPane {...props()} globalEnabled={false} />);
    await screen.findByText("docker ps");
    expect(screen.getByRole("button", { name: "Pause" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Disabled globally")).toBeTruthy();
  });

  it("changes only the selected connection's capture setting", async () => {
    const options = props();
    api.historyIntegrationStatus.mockResolvedValue("installed");
    api.setConnectionHistoryEnabled.mockResolvedValue({ ...connection, historyEnabled: false });
    render(<HistoryPane {...options} />);
    await screen.findByText("docker ps");
    await clickAction("Disable on this connection");
    expect(api.setConnectionHistoryEnabled).toHaveBeenCalledExactlyOnceWith(connection.id, false);
    expect(options.onConnectionChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: connection.id, historyEnabled: false }),
    );
  });

  it("does not let a previous connection's pending refresh overwrite the current integration state", async () => {
    api.historyIntegrationStatus.mockResolvedValue("installed");
    const options = props();
    const view = render(<HistoryPane {...options} />);
    await screen.findByText("docker ps");
    let finish!: (value: HistoryIntegrationStatus) => void;
    api.historyIntegrationStatus.mockImplementationOnce(
      () =>
        new Promise<HistoryIntegrationStatus>((resolve) => {
          finish = resolve;
        }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    api.historyIntegrationStatus.mockResolvedValue("not-installed");
    api.history.mockResolvedValue([]);
    view.rerender(
      <HistoryPane
        {...options}
        connection={{ ...connection, id: "connection-b", displayName: "Host B" }}
      />,
    );
    await screen.findByRole("button", { name: "Enable Enhanced History" });
    await act(async () => finish("installed"));
    expect(screen.getByRole("button", { name: "Enable Enhanced History" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disable on this connection" })).toBeNull();
  });
  it.each(["install", "uninstall", "toggle", "delete", "clear"])(
    "ignores late %s completion after switching hosts",
    async (operation) => {
      const options = props();
      api.historyIntegrationStatus.mockResolvedValue(
        operation === "install" ? "not-installed" : "installed",
      );
      const method = {
        install: api.installHistoryIntegration,
        uninstall: api.uninstallHistoryIntegration,
        toggle: api.setConnectionHistoryEnabled,
        delete: api.deleteHistory,
        clear: api.clearHistory,
      }[operation]!;
      let finish!: (value: unknown) => void;
      method.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const view = render(<HistoryPane {...options} />);
      await screen.findByText("docker ps");
      const labels = {
        install: "Enable Enhanced History",
        uninstall: "Remove from remote Bash",
        toggle: "Disable on this connection",
        delete: "Delete history entry",
        clear: "Clear saved history",
      };
      await clickAction(labels[operation as keyof typeof labels]);
      if (operation === "uninstall")
        await userEvent.click(screen.getByRole("button", { name: "Remove integration" }));
      if (operation === "clear")
        await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
      api.history.mockResolvedValue([
        { id: "entry-a", command: "HOST_B_COMMAND", startedAt: "2026-08-27T10:00:00Z" },
      ]);
      view.rerender(
        <HistoryPane {...options} connection={{ ...connection, id: "connection-b" }} />,
      );
      await screen.findByText("HOST_B_COMMAND");
      await act(async () => finish(connection));
      expect(screen.getByText("HOST_B_COMMAND")).toBeTruthy();
      expect(options.onConnectionChanged).not.toHaveBeenCalled();
    },
  );

  it("ignores a late mutation error and releases the new host's controls", async () => {
    api.historyIntegrationStatus.mockResolvedValue("not-installed");
    let fail!: (reason: Error) => void;
    api.installHistoryIntegration.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const options = props();
    const view = render(<HistoryPane {...options} />);
    await userEvent.click(await screen.findByRole("button", { name: "Enable Enhanced History" }));
    view.rerender(<HistoryPane {...options} connection={{ ...connection, id: "connection-b" }} />);
    const button = await screen.findByRole("button", { name: "Enable Enhanced History" });
    expect(button.hasAttribute("disabled")).toBe(false);
    await act(async () => fail(new Error("OLD_HOST_ERROR")));
    expect(screen.queryByText("OLD_HOST_ERROR")).toBeNull();
  });

  describe("entry rows", () => {
    it("shows the exit status on the row with the exact nonzero code and no badge", async () => {
      const failedEntry = { ...historyEntry, id: "entry-f", command: "npx t3 pair", exitCode: 130 };
      const unknownEntry = { ...historyEntry, id: "entry-u", command: "weird", exitCode: null };
      api.history.mockResolvedValue([{ ...historyEntry }, failedEntry, unknownEntry]);
      render(<HistoryPane {...props()} />);
      await screen.findByText("npx t3 pair");
      expect(screen.getByLabelText("Command succeeded")).toBeTruthy();
      expect(screen.getByText("130")).toBeTruthy();
      expect(screen.getByLabelText("Command failed, exit code 130")).toBeTruthy();
      expect(screen.getByLabelText("Exit code unknown")).toBeTruthy();
      expect(document.querySelector(".exit-code")).toBeNull();
      const commands = [...document.querySelectorAll("code.history-command")];
      expect(commands.map((element) => element.textContent)).toContain("npx t3 pair");
    });

    it("preserves multiline command text exactly and copies the complete original", async () => {
      const command = 'git add -A\ngit commit -m "two lines"';
      api.history.mockResolvedValue([{ ...historyEntry, command }]);
      const writeText = stubClipboard();
      const view = render(<HistoryPane {...props()} />);
      await screen.findByText(/git commit/);
      expect(view.container.querySelector("code.history-command")?.textContent).toBe(command);
      await userEvent.click(screen.getByRole("button", { name: "Copy command" }));
      expect(writeText).toHaveBeenCalledExactlyOnceWith(command);
    });

    it("confirms a copy and returns the button to its resting label", async () => {
      const writeText = stubClipboard();
      render(<HistoryPane {...props()} />);
      await screen.findByText("docker ps");
      await userEvent.click(screen.getByRole("button", { name: "Copy command" }));
      expect(writeText).toHaveBeenCalledExactlyOnceWith("docker ps");
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
      await waitFor(
        () => expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy(),
        { timeout: 2500 },
      );
    });

    it("announces a copy failure instead of a false success", async () => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: vi.fn().mockRejectedValue(new Error("clipboard unavailable")),
        },
        configurable: true,
        writable: true,
      });
      render(<HistoryPane {...props()} />);
      await screen.findByText("docker ps");
      await userEvent.click(screen.getByRole("button", { name: "Copy command" }));
      expect(await screen.findByText(/clipboard unavailable/)).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toContain("clipboard unavailable");
      expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
    });

    it("shows the working directory and names it unavailable when absent", async () => {
      api.history.mockResolvedValue([
        { ...historyEntry },
        { ...historyEntry, id: "entry-n", command: "cd ~", cwd: null },
      ]);
      render(<HistoryPane {...props()} />);
      await screen.findByText("cd ~");
      expect(screen.getByText("/srv")).toBeTruthy();
      expect(screen.getByText("Directory unavailable")).toBeTruthy();
    });
  });

  describe("search", () => {
    it("separates a search with no matches from an empty history", async () => {
      const user = userEvent.setup();
      api.history.mockImplementation((id: string, query?: string) =>
        query ? Promise.resolve([]) : Promise.resolve([{ ...historyEntry }]),
      );
      api.historyIntegrationStatus.mockResolvedValue("installed");
      render(<HistoryPane {...props()} />);
      await screen.findByText("docker ps");
      await user.type(screen.getByPlaceholderText("Search commands"), "zzz");
      expect(await screen.findByText("No matching commands")).toBeTruthy();
      expect(screen.queryByText("No commands recorded yet")).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
      await screen.findByText("docker ps");
      expect((screen.getByPlaceholderText("Search commands") as HTMLInputElement).value).toBe("");
    });

    it("highlights matched text without changing the stored command or copy payload", async () => {
      const user = userEvent.setup();
      api.historyIntegrationStatus.mockResolvedValue("installed");
      const writeText = stubClipboard();
      const view = render(<HistoryPane {...props()} />);
      await screen.findByText("docker ps");
      await user.type(screen.getByPlaceholderText("Search commands"), "dock");
      await waitFor(() => expect(view.container.querySelector("mark")?.textContent).toBe("dock"));
      await userEvent.click(screen.getByRole("button", { name: "Copy command" }));
      expect(writeText).toHaveBeenCalledExactlyOnceWith("docker ps");
    });
  });

  describe("capture state and management menu", () => {
    it("reads the capture state from actual signals", async () => {
      api.historyIntegrationStatus.mockResolvedValue("installed");
      const options = props();
      const view = render(<HistoryPane {...options} />);
      expect(await screen.findByText("Recording")).toBeTruthy();
      view.rerender(<HistoryPane {...options} paused />);
      expect(screen.getByText("Paused in this workspace")).toBeTruthy();
      view.rerender(
        <HistoryPane {...options} connection={{ ...connection, historyEnabled: false }} />,
      );
      expect(screen.getByText("Disabled for this connection")).toBeTruthy();
      view.rerender(<HistoryPane {...options} globalEnabled={false} />);
      expect(screen.getByText("Disabled globally")).toBeTruthy();
      api.historyIntegrationStatus.mockResolvedValue("not-installed");
      view.rerender(
        <HistoryPane {...options} connection={{ ...connection, id: "connection-b" }} />,
      );
      expect(await screen.findByText("Integration not installed")).toBeTruthy();
      api.historyIntegrationStatus.mockRejectedValue(new Error("Host is offline"));
      view.rerender(
        <HistoryPane {...options} connection={{ ...connection, id: "connection-c" }} />,
      );
      expect(await screen.findByText("Status unavailable")).toBeTruthy();
    });

    it("keeps de-emphasized management actions in a labeled, dismissible menu", async () => {
      api.historyIntegrationStatus.mockResolvedValue("installed");
      render(<HistoryPane {...props()} />);
      await screen.findByText("docker ps");
      const trigger = screen.getByRole("button", { name: "More actions" });
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      await userEvent.click(trigger);
      expect(screen.getByRole("menu")).toBeTruthy();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getAllByRole("menuitem")).toHaveLength(3);
      expect(screen.getByRole("menuitem", { name: "Disable on this connection" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Clear saved history" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Remove from remote Bash" })).toBeTruthy();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
      expect(screen.queryByRole("menuitem")).toBeNull();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });
  });
  it("keeps a deleted row mounted until its successful collapse completes", async () => {
    api.historyIntegrationStatus.mockResolvedValue("installed");
    let finish!: () => void;
    api.deleteHistory.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<HistoryPane {...props()} />);
    await screen.findByText("docker ps");
    await userEvent.click(screen.getByRole("button", { name: "Delete history entry" }));
    expect(view.container.querySelector(".history-row")?.hasAttribute("data-removing")).toBe(false);
    await act(async () => finish());
    expect(view.container.querySelector(".history-row[data-removing]")).not.toBeNull();
    expect(screen.getByText("docker ps")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("docker ps")).toBeNull());
  });

  it("preserves row identity, keyboard focus and command scroll when refresh settles", async () => {
    render(<HistoryPane {...props()} />);
    await screen.findByText("docker ps");
    let finish!: (entries: (typeof historyEntry)[]) => void;
    api.history.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const copy = screen.getByRole("button", { name: "Copy command" });
    const code = document.querySelector<HTMLElement>(".history-command")!;
    code.scrollTop = 50;
    copy.focus();
    await act(async () => finish([{ ...historyEntry }]));
    expect(document.activeElement).toBe(copy);
    expect(document.querySelector(".history-command")).toBe(code);
    expect(code.scrollTop).toBe(50);
  });

  it("returns keyboard focus to More after Escape dismisses its focused menu", async () => {
    api.historyIntegrationStatus.mockResolvedValue("installed");
    render(<HistoryPane {...props()} />);
    await screen.findByText("docker ps");
    const more = screen.getByRole("button", { name: "More actions" });
    await userEvent.click(more);
    screen.getByRole("menuitem", { name: "Disable on this connection" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("reports unavailable after a failed refresh of a previously missing integration", async () => {
    api.historyIntegrationStatus.mockResolvedValueOnce("not-installed");
    render(<HistoryPane {...props()} />);
    await screen.findByText("Integration not installed");
    api.historyIntegrationStatus.mockRejectedValueOnce(new Error("SSH unavailable"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(/could not check the remote Bash integration/);
    expect(screen.getByText("Status unavailable")).toBeTruthy();
  });
  it("keeps refresh busy until the remote integration check also settles", async () => {
    api.historyIntegrationStatus.mockResolvedValueOnce("installed");
    render(<HistoryPane {...props()} />);
    await screen.findByText("Recording");
    let finish!: (value: HistoryIntegrationStatus) => void;
    api.historyIntegrationStatus.mockImplementationOnce(
      () =>
        new Promise<HistoryIntegrationStatus>((resolve) => {
          finish = resolve;
        }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(true);
    expect(document.querySelector(".spinning")).not.toBeNull();
    await act(async () => finish("installed"));
    expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(false);
  });

  it.each([
    {
      globalEnabled: false,
      paused: false,
      enabled: true,
      guidance: "Enable Enhanced History globally in Settings to record new commands.",
    },
    {
      globalEnabled: true,
      paused: false,
      enabled: false,
      guidance: "Enable on this connection from More actions to record new commands.",
    },
    {
      globalEnabled: true,
      paused: true,
      enabled: true,
      guidance: "Resume recording in this workspace to record new commands.",
    },
  ])(
    "gives actionable empty-history guidance for $guidance",
    async ({ globalEnabled, paused, enabled, guidance }) => {
      api.history.mockResolvedValue([]);
      api.historyIntegrationStatus.mockResolvedValue("installed");
      render(
        <HistoryPane
          {...props()}
          globalEnabled={globalEnabled}
          paused={paused}
          connection={{ ...connection, historyEnabled: enabled }}
        />,
      );
      await screen.findByText("No commands recorded yet");
      expect(screen.getByText(guidance)).toBeTruthy();
    },
  );

  it("ignores a stale clipboard completion after a newer copy", async () => {
    api.history.mockResolvedValue([
      { ...historyEntry },
      { ...historyEntry, id: "entry-b", command: "git status" },
    ]);
    const writeText = stubClipboard();
    let finish!: () => void;
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<HistoryPane {...props()} />);
    await screen.findByText("git status");
    await userEvent.click(screen.getAllByRole("button", { name: "Copy command" })[0]);
    await userEvent.click(screen.getAllByRole("button", { name: "Copy command" })[1]);
    await act(async () => finish());
    expect(
      screen.getByRole("button", { name: "Copied" }).closest("article")?.textContent,
    ).toContain("git status");
  });

  it.each([false, true])("dismisses More actions on Tab, backwards: %s", async (backwards) => {
    api.historyIntegrationStatus.mockResolvedValue("installed");
    render(<HistoryPane {...props()} />);
    await screen.findByText("docker ps");
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.keyboard(backwards ? "{Shift>}{Tab}{/Shift}" : "{Tab}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole(backwards ? "button" : "textbox", {
        name: backwards ? "More actions" : "Search commands",
      }),
    );
  });

  it("identifies empty local history when the remote status is unavailable", async () => {
    api.history.mockResolvedValue([]);
    render(<HistoryPane {...props()} />);
    expect(await screen.findByText("No saved commands")).toBeTruthy();
    expect(screen.getByText(/could not check the remote Bash integration/)).toBeTruthy();
    expect(screen.queryByText(/Reconnect this connection or open a new terminal, then/)).toBeNull();
  });

  it("describes resuming recording on the Resume button", async () => {
    render(<HistoryPane {...props()} paused />);
    const resume = await screen.findByRole("button", { name: "Resume" });
    expect(resume.title).toBe("Resume recording for this Workspace");
  });

  it("avoids capture guidance based on a cached integration status after a failed refresh", async () => {
    api.history.mockResolvedValue([]);
    api.historyIntegrationStatus.mockResolvedValueOnce("installed");
    render(<HistoryPane {...props()} />);
    await screen.findByText("No commands recorded yet");
    api.historyIntegrationStatus.mockRejectedValueOnce(new Error("Host is offline"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("No saved commands");
    expect(screen.queryByText("No commands recorded yet")).toBeNull();
  });
});
