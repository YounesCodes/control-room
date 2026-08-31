// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createConnectionGroup: vi.fn(),
  renameConnectionGroup: vi.fn(),
  deleteConnectionGroup: vi.fn(),
  moveConnectionGroup: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type { ConnectionGroup } from "../types";
import { ConnectionGroupsDialog } from "./ConnectionGroupsDialog";

const production: ConnectionGroup = {
  id: "production-id",
  name: "Production",
  position: 0,
  collapsed: false,
};
const homelab: ConnectionGroup = {
  id: "homelab-id",
  name: "Homelab",
  position: 1,
  collapsed: true,
};
const staging: ConnectionGroup = {
  id: "staging-id",
  name: "Staging",
  position: 2,
  collapsed: false,
};

describe("ConnectionGroupsDialog", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("creates and reorders groups through local organization commands", async () => {
    const user = userEvent.setup();
    const onGroupsChange = vi.fn();
    api.createConnectionGroup.mockResolvedValue(staging);
    api.moveConnectionGroup.mockResolvedValue([homelab, production]);
    render(
      <ConnectionGroupsDialog
        groups={[production, homelab]}
        onGroupsChange={onGroupsChange}
        onGroupDeleted={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("New group"), "Staging");
    await user.click(screen.getByRole("button", { name: "Add group" }));
    expect(api.createConnectionGroup).toHaveBeenCalledWith("Staging");
    expect(onGroupsChange).toHaveBeenCalledWith([production, homelab, staging]);

    screen.getByRole("button", { name: "Move Homelab up" }).focus();
    await user.keyboard("{Enter}");
    expect(api.moveConnectionGroup).toHaveBeenCalledWith(homelab.id, "up");
    expect(onGroupsChange).toHaveBeenLastCalledWith([homelab, production]);
  });

  it("requires inline confirmation before deleting a group", async () => {
    const user = userEvent.setup();
    const onGroupsChange = vi.fn();
    const onGroupDeleted = vi.fn();
    api.deleteConnectionGroup.mockResolvedValue(undefined);
    render(
      <ConnectionGroupsDialog
        groups={[production, homelab]}
        onGroupsChange={onGroupsChange}
        onGroupDeleted={onGroupDeleted}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete Production" }));
    expect(api.deleteConnectionGroup).not.toHaveBeenCalled();
    expect(screen.getByText("Delete Production?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete group" }));

    expect(api.deleteConnectionGroup).toHaveBeenCalledWith(production.id);
    expect(onGroupsChange).toHaveBeenCalledWith([homelab]);
    expect(onGroupDeleted).toHaveBeenCalledWith(production.id);
  });
});
