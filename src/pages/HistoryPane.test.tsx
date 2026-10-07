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
import type { SavedConnection } from "../types";

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
    api.history.mockResolvedValue([
      {
        id: "entry-a",
        connectionId: connection.id,
        sessionId: "session-a",
        command: "docker ps",
        cwd: "/srv",
        startedAt: "2026-08-27T10:00:00Z",
        finishedAt: "2026-08-27T10:00:01Z",
        exitCode: 0,
        shell: "bash",
      },
    ]);
    api.historyIntegrationStatus.mockRejectedValue(new Error("Host is offline"));
  });

  it("retains saved commands after clear fails and retries the confirmed operation", async () => {
    api.clearHistory
      .mockRejectedValueOnce(new Error("database locked"))
      .mockResolvedValue(undefined);
    render(<HistoryPane {...props()} />);
    await screen.findByText("docker ps");
    await userEvent.click(screen.getByRole("button", { name: "Clear saved history" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    await screen.findByText("database locked");
    expect(screen.getByText("docker ps")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear saved history" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    await waitFor(() => expect(screen.queryByText("docker ps")).toBeNull());
  });

  it("reports integration installation failure without enabling capture and allows retry", async () => {
    api.historyIntegrationStatus.mockResolvedValue(false);
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
    api.clearHistory.mockResolvedValue(undefined);
    render(<HistoryPane {...props()} />);
    await screen.findByText("docker ps");
    await userEvent.click(screen.getByRole("button", { name: "Clear saved history" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.clearHistory).not.toHaveBeenCalled();
    expect(screen.getByText("docker ps")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear saved history" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    await waitFor(() => expect(screen.queryByText("docker ps")).toBeNull());
    expect(api.clearHistory).toHaveBeenCalledExactlyOnceWith(connection.id);
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
    api.historyIntegrationStatus.mockResolvedValue(true);
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
    expect(screen.getByText(/disabled globally/)).toBeTruthy();
  });

  it("changes only the selected connection's capture setting", async () => {
    const options = props();
    api.historyIntegrationStatus.mockResolvedValue(true);
    api.setConnectionHistoryEnabled.mockResolvedValue({ ...connection, historyEnabled: false });
    render(<HistoryPane {...options} />);
    await screen.findByText("docker ps");
    await userEvent.click(screen.getByRole("button", { name: "Disable on this connection" }));
    expect(api.setConnectionHistoryEnabled).toHaveBeenCalledExactlyOnceWith(connection.id, false);
    expect(options.onConnectionChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: connection.id, historyEnabled: false }),
    );
  });

  it("does not let a previous connection's pending refresh overwrite the current integration state", async () => {
    api.historyIntegrationStatus.mockResolvedValue(true);
    const options = props();
    const view = render(<HistoryPane {...options} />);
    await screen.findByText("docker ps");
    let finish!: (value: boolean) => void;
    api.historyIntegrationStatus.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    api.historyIntegrationStatus.mockResolvedValue(false);
    api.history.mockResolvedValue([]);
    view.rerender(
      <HistoryPane
        {...options}
        connection={{ ...connection, id: "connection-b", displayName: "Host B" }}
      />,
    );
    await screen.findByRole("button", { name: "Enable Enhanced History" });
    await act(async () => finish(true));
    expect(screen.getByRole("button", { name: "Enable Enhanced History" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disable on this connection" })).toBeNull();
  });
  it.each(["install", "uninstall", "toggle", "delete", "clear"])(
    "ignores late %s completion after switching hosts",
    async (operation) => {
      const options = props();
      api.historyIntegrationStatus.mockResolvedValue(operation !== "install");
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
      await userEvent.click(
        screen.getByRole("button", { name: labels[operation as keyof typeof labels] }),
      );
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
    api.historyIntegrationStatus.mockResolvedValue(false);
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
});
