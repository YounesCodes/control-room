// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionTag, SavedConnection } from "../types";

const api = vi.hoisted(() => ({
  updateConnection: vi.fn(),
  createConnection: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { ConnectionDialog } from "./ConnectionDialog";

const critical: ConnectionTag = { id: "critical-id", name: "Critical", color: "#8250df" };
const docker: ConnectionTag = { id: "docker-id", name: "Docker", color: "#3a3a3a" };
const connection: SavedConnection = {
  id: "connection-id",
  displayName: "Server",
  destination: "server",
  username: "user",
  port: null,
  identityFile: null,
  historyEnabled: false,
  sudoEnabled: false,
  groupId: null,
  tags: [critical],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

describe("ConnectionDialog tags", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("assigns existing tags without exposing tag creation or color editing", async () => {
    const user = userEvent.setup();
    api.updateConnection.mockResolvedValue({ ...connection, tags: [docker] });
    render(
      <ConnectionDialog
        connection={connection}
        groups={[]}
        knownTags={[critical, docker]}
        globalSudoEnabled={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.queryByRole("textbox", { name: "Tags" })).toBeNull();
    expect(screen.queryByLabelText("Color for Critical")).toBeNull();
    expect(screen.getByRole("button", { name: "Critical" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Critical" }));
    await user.click(screen.getByRole("button", { name: "Docker" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(api.updateConnection).toHaveBeenCalledWith(
      connection.id,
      expect.objectContaining({ tagNames: ["Docker"] }),
    );
  });
});

const elevationLabel = "Allow sudo for Structured Operations on this host";

describe("ConnectionDialog elevation", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("saves the per-host choice while the global setting is off", async () => {
    const user = userEvent.setup();
    api.updateConnection.mockResolvedValue({ ...connection, sudoEnabled: true });
    render(
      <ConnectionDialog
        connection={connection}
        groups={[]}
        knownTags={[]}
        globalSudoEnabled={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: elevationLabel });
    expect((checkbox as HTMLInputElement).disabled).toBe(false);
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(api.updateConnection).toHaveBeenCalledWith(
      connection.id,
      expect.objectContaining({ sudoEnabled: true }),
    );
  });

  it("locks the per-host control and says why when the global setting is on", () => {
    render(
      <ConnectionDialog
        connection={connection}
        groups={[]}
        knownTags={[]}
        globalSudoEnabled
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: elevationLabel }) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(true);
    expect(screen.getByText(/Settings allows sudo for every Saved Connection/)).toBeTruthy();
  });

  it("keeps the host's own choice so turning the global setting off restores it", async () => {
    const optedIn: SavedConnection = { ...connection, sudoEnabled: true };
    api.updateConnection.mockResolvedValue(optedIn);
    const user = userEvent.setup();
    render(
      <ConnectionDialog
        connection={optedIn}
        groups={[]}
        knownTags={[]}
        globalSudoEnabled
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(api.updateConnection).toHaveBeenCalledWith(
      optedIn.id,
      expect.objectContaining({ sudoEnabled: true }),
    );
  });
});
