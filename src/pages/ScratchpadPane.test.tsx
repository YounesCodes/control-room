// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  scratchpadNote: vi.fn(),
  saveScratchpadNote: vi.fn(),
  deleteScratchpadNote: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { scratchpadDraftKey } from "../lib/scratchpad-draft";
import type { SavedConnection, ScratchpadNote, ScratchpadNoteInput } from "../types";
import { ScratchpadPane } from "./ScratchpadPane";

const connection: SavedConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Host A",
  destination: "host-a",
  username: "user",
  port: null,
  identityFile: null,
  historyEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};
const workspaceId = "22222222-2222-4222-8222-222222222222";

function savedNote(input: ScratchpadNoteInput): ScratchpadNote {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    ...input,
    createdAt: "created",
    updatedAt: "updated",
  };
}

describe("ScratchpadPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    api.scratchpadNote.mockResolvedValue(null);
    api.saveScratchpadNote.mockImplementation(async (input: ScratchpadNoteInput) =>
      savedNote(input),
    );
    api.deleteScratchpadNote.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("autosaves plain text without rendering pasted HTML", async () => {
    render(<ScratchpadPane connection={connection} workspaceId={workspaceId} />);
    const editor = await screen.findByLabelText("Connection note");
    const text = '<img src=x onerror="alert(1)">\n<script>alert(2)</script>';
    fireEvent.change(editor, { target: { value: text } });

    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    await waitFor(() => expect(api.saveScratchpadNote).toHaveBeenCalled(), { timeout: 2_000 });
    expect(api.saveScratchpadNote).toHaveBeenLastCalledWith({
      scope: "connection",
      ownerId: connection.id,
      connectionId: connection.id,
      text,
    });
    await screen.findByText("Saved locally");
    expect(window.localStorage.getItem(scratchpadDraftKey("connection", connection.id))).toBeNull();
  });

  it("retains the latest fallback draft when SQLite autosave fails and retries it", async () => {
    const user = userEvent.setup();
    api.saveScratchpadNote.mockRejectedValueOnce(new Error("disk full"));
    render(<ScratchpadPane connection={connection} workspaceId={workspaceId} />);
    const editor = await screen.findByLabelText("Connection note");
    fireEvent.change(editor, { target: { value: "Do not lose this" } });

    await screen.findByText(/Autosave failed.*disk full/, {}, { timeout: 2_000 });
    expect(window.localStorage.getItem(scratchpadDraftKey("connection", connection.id))).toBe(
      "Do not lose this",
    );
    await user.click(screen.getByRole("button", { name: "Retry save" }));
    await screen.findByText("Saved locally");
    expect(api.saveScratchpadNote).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(scratchpadDraftKey("connection", connection.id))).toBeNull();
  });

  it("does not overwrite SQLite from a fallback draft until a failed load is retried", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(scratchpadDraftKey("connection", connection.id), "Recovered draft");
    api.scratchpadNote.mockRejectedValueOnce(new Error("database busy"));
    render(<ScratchpadPane connection={connection} workspaceId={workspaceId} />);

    expect(await screen.findByLabelText("Connection note")).toHaveProperty(
      "value",
      "Recovered draft",
    );
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    expect(api.saveScratchpadNote).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Retry load" }));
    await waitFor(() => expect(api.scratchpadNote).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.saveScratchpadNote).toHaveBeenCalled(), { timeout: 2_000 });
  });

  it("labels Workspace ownership and deletes that note explicitly", async () => {
    const user = userEvent.setup();
    api.scratchpadNote.mockImplementation(
      async (scope: string, ownerId: string): Promise<ScratchpadNote | null> =>
        scope === "workspace"
          ? savedNote({
              scope: "workspace",
              ownerId,
              connectionId: connection.id,
              text: "Temporary investigation",
            })
          : null,
    );
    render(<ScratchpadPane connection={connection} workspaceId={workspaceId} />);
    await screen.findByLabelText("Connection note");
    await user.click(screen.getByRole("button", { name: "This Workspace" }));

    expect(await screen.findByLabelText("Workspace note")).toHaveProperty(
      "value",
      "Temporary investigation",
    );
    expect(screen.getByText("Deleted when this Workspace is closed")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete note" }));
    await user.click(screen.getAllByRole("button", { name: "Delete note" }).at(-1)!);
    await waitFor(() =>
      expect(api.deleteScratchpadNote).toHaveBeenCalledWith(
        "workspace",
        workspaceId,
        connection.id,
      ),
    );
  });
});
