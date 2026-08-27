// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

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
});
