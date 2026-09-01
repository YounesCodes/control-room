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
