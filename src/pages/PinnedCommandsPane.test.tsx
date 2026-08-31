// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  pinnedCommands: vi.fn(),
  createPinnedCommand: vi.fn(),
  updatePinnedCommand: vi.fn(),
  reorderPinnedCommands: vi.fn(),
  deletePinnedCommand: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type { PinnedCommand, PinnedCommandInput, SavedConnection } from "../types";
import { PinnedCommandsPane } from "./PinnedCommandsPane";

const connection: SavedConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Host A",
  destination: "host-a",
  username: "user",
  port: null,
  identityFile: null,
  historyEnabled: false,
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

function command(
  id: string,
  name: string,
  text: string,
  connectionId: string | null,
  position: number,
): PinnedCommand {
  return {
    id,
    name,
    command: text,
    connectionId,
    position,
    createdAt: "created",
    updatedAt: "updated",
  };
}

const disk = command("22222222-2222-4222-8222-222222222222", "Disk usage", "df -h", null, 0);
const failed = command(
  "33333333-3333-4333-8333-333333333333",
  "Failed units",
  "systemctl --failed",
  null,
  1,
);

describe("PinnedCommandsPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.pinnedCommands.mockResolvedValue([disk, failed]);
    api.createPinnedCommand.mockImplementation(async (input: PinnedCommandInput) =>
      command(
        "44444444-4444-4444-8444-444444444444",
        input.name,
        input.command,
        input.connectionId,
        0,
      ),
    );
    api.updatePinnedCommand.mockImplementation(async (_id: string, input: PinnedCommandInput) =>
      command(disk.id, input.name, input.command, input.connectionId, 0),
    );
    api.reorderPinnedCommands.mockResolvedValue(undefined);
    api.deletePinnedCommand.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("previews exact text and inserts it only after explicit confirmation", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<PinnedCommandsPane connection={connection} canInsert onInsert={onInsert} />);

    await user.click((await screen.findAllByRole("button", { name: "Insert" }))[0]);
    expect(screen.getByText(/cannot verify that the current prompt is empty/i)).toBeTruthy();
    expect(screen.getAllByText("df -h")).toHaveLength(2);
    expect(onInsert).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Insert without Enter" }));

    expect(onInsert).toHaveBeenCalledWith("df -h");
    expect(onInsert.mock.calls[0][0]).not.toContain("\n");
  });

  it("keeps insertion unavailable while the terminal is disconnected", async () => {
    render(<PinnedCommandsPane connection={connection} canInsert={false} onInsert={vi.fn()} />);

    expect(await screen.findByText(/Reconnect this Workspace’s Terminal Session/)).toBeTruthy();
    for (const button of screen.getAllByRole("button", { name: "Insert" })) {
      expect(button.hasAttribute("disabled")).toBe(true);
    }
  });

  it("creates a connection-scoped one-line command", async () => {
    const user = userEvent.setup();
    api.pinnedCommands.mockResolvedValue([]);
    render(<PinnedCommandsPane connection={connection} canInsert onInsert={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Add command" }));
    await user.type(screen.getByLabelText("Name"), "API status");
    await user.type(screen.getByPlaceholderText("df -h"), "systemctl status api");
    await user.selectOptions(screen.getByRole("combobox"), "connection");
    await user.click(screen.getAllByRole("button", { name: "Add command" }).at(-1)!);

    await waitFor(() =>
      expect(api.createPinnedCommand).toHaveBeenCalledWith({
        name: "API status",
        command: "systemctl status api",
        connectionId: connection.id,
      }),
    );
  });

  it("persists the complete reordered scope", async () => {
    const user = userEvent.setup();
    render(<PinnedCommandsPane connection={connection} canInsert onInsert={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Move Failed units up" }));
    expect(api.reorderPinnedCommands).toHaveBeenCalledWith(null, [failed.id, disk.id]);
  });

  it("renames, rescopes, and deletes a command", async () => {
    const user = userEvent.setup();
    render(<PinnedCommandsPane connection={connection} canInsert onInsert={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Edit Disk usage" }));
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Host disk usage");
    await user.selectOptions(screen.getByRole("combobox"), "connection");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(api.updatePinnedCommand).toHaveBeenCalledWith(disk.id, {
        name: "Host disk usage",
        command: "df -h",
        connectionId: connection.id,
      }),
    );

    await user.click(await screen.findByRole("button", { name: "Delete Host disk usage" }));
    await user.click(screen.getByRole("button", { name: "Delete command" }));
    await waitFor(() => expect(api.deletePinnedCommand).toHaveBeenCalledWith(disk.id));
  });
});
