// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createConnectionGroup: vi.fn(),
  renameConnectionGroup: vi.fn(),
  deleteConnectionGroup: vi.fn(),
  moveConnectionGroup: vi.fn(),
  createConnectionTag: vi.fn(),
  renameConnectionTag: vi.fn(),
  deleteConnectionTag: vi.fn(),
  setConnectionTagColor: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type { ConnectionGroup, ConnectionTag } from "../types";
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
const critical: ConnectionTag = {
  id: "critical-id",
  name: "Critical",
  color: "#8250df",
};
const docker: ConnectionTag = {
  id: "docker-id",
  name: "Docker",
  color: "#3a3a3a",
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
        tags={[]}
        onGroupsChange={onGroupsChange}
        onTagsChange={vi.fn()}
        onGroupDeleted={vi.fn()}
        onTagUpdated={vi.fn()}
        onTagDeleted={vi.fn()}
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
        tags={[]}
        onGroupsChange={onGroupsChange}
        onTagsChange={vi.fn()}
        onGroupDeleted={onGroupDeleted}
        onTagUpdated={vi.fn()}
        onTagDeleted={vi.fn()}
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

  it("creates, edits, recolors, and deletes tags from the organization dialog", async () => {
    const user = userEvent.setup();
    const onTagsChange = vi.fn();
    const onTagUpdated = vi.fn();
    const onTagDeleted = vi.fn();
    api.createConnectionTag.mockResolvedValue(docker);
    api.renameConnectionTag.mockResolvedValue({ ...critical, name: "Priority" });
    api.deleteConnectionTag.mockResolvedValue(undefined);
    api.setConnectionTagColor.mockResolvedValue({ ...critical, color: "#0969da" });
    render(
      <ConnectionGroupsDialog
        groups={[]}
        tags={[critical]}
        onGroupsChange={vi.fn()}
        onTagsChange={onTagsChange}
        onGroupDeleted={vi.fn()}
        onTagUpdated={onTagUpdated}
        onTagDeleted={onTagDeleted}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("New tag"), "Docker");
    await user.click(screen.getByRole("button", { name: "Add tag" }));
    expect(api.createConnectionTag).toHaveBeenCalledWith("Docker", "#3a3a3a");
    expect(onTagsChange).toHaveBeenCalledWith([critical, docker]);

    fireEvent.change(screen.getByLabelText("Color for Critical"), {
      target: { value: "#0969da" },
    });
    expect(api.setConnectionTagColor).toHaveBeenCalledWith(critical.id, "#0969da");
    await waitFor(() =>
      expect(onTagUpdated).toHaveBeenCalledWith({ ...critical, color: "#0969da" }),
    );

    await user.click(screen.getByRole("button", { name: "Rename Critical" }));
    const renameInput = screen.getByLabelText("Rename Critical");
    await user.clear(renameInput);
    await user.type(renameInput, "Priority");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.renameConnectionTag).toHaveBeenCalledWith(critical.id, "Priority");
    expect(onTagUpdated).toHaveBeenCalledWith({ ...critical, name: "Priority" });

    await user.click(screen.getByRole("button", { name: "Delete Critical" }));
    expect(api.deleteConnectionTag).not.toHaveBeenCalled();
    expect(screen.getByText("Delete Critical from every connection?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete tag" }));
    expect(api.deleteConnectionTag).toHaveBeenCalledWith(critical.id);
    expect(onTagDeleted).toHaveBeenCalledWith(critical.id);
  });
});
