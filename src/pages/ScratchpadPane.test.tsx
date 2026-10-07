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
  sudoEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};
function savedNote(input: ScratchpadNoteInput): ScratchpadNote {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    ...input,
    createdAt: "created",
    updatedAt: "updated",
  };
}

describe("ScratchpadPane", () => {
  it("waits for an in-flight save before deleting and never recreates the note", async () => {
    let finish!: (note: ScratchpadNote) => void;
    api.saveScratchpadNote.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<ScratchpadPane connection={connection} />);
    const editor = await screen.findByLabelText("Connection note");
    fireEvent.change(editor, { target: { value: "first version" } });
    await waitFor(() => expect(api.saveScratchpadNote).toHaveBeenCalledTimes(1), { timeout: 2000 });
    fireEvent.change(editor, { target: { value: "newer version" } });
    await userEvent.click(screen.getByRole("button", { name: "Delete note" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Delete note" }).at(-1)!);
    expect(api.deleteScratchpadNote).not.toHaveBeenCalled();
    finish(
      savedNote({
        scope: "connection",
        ownerId: connection.id,
        connectionId: connection.id,
        text: "first version",
      }),
    );
    await waitFor(() => expect(api.deleteScratchpadNote).toHaveBeenCalledOnce());
    expect(editor).toHaveProperty("value", "");
    expect(api.saveScratchpadNote).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(scratchpadDraftKey("connection", connection.id))).toBeNull();
  });

  it("keeps text and its fallback draft when deletion fails, then retries deletion", async () => {
    api.scratchpadNote.mockResolvedValue(
      savedNote({
        scope: "connection",
        ownerId: connection.id,
        connectionId: connection.id,
        text: "keep me",
      }),
    );
    api.deleteScratchpadNote.mockRejectedValueOnce(new Error("database locked"));
    render(<ScratchpadPane connection={connection} />);
    const editor = await screen.findByLabelText("Connection note");
    fireEvent.change(editor, { target: { value: "keep newer text" } });
    await userEvent.click(screen.getByRole("button", { name: "Delete note" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Delete note" }).at(-1)!);
    await screen.findByText(/Could not delete the note: database locked/);
    expect(editor).toHaveProperty("value", "keep newer text");
    expect(window.localStorage.getItem(scratchpadDraftKey("connection", connection.id))).toBe(
      "keep newer text",
    );
    await userEvent.click(screen.getAllByRole("button", { name: "Delete note" }).at(-1)!);
    await waitFor(() => expect(editor).toHaveProperty("value", ""));
  });
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
    render(<ScratchpadPane connection={connection} />);
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
    render(<ScratchpadPane connection={connection} />);
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
    render(<ScratchpadPane connection={connection} />);

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

  it("undoes and redoes text removal and the Clear text action", async () => {
    const user = userEvent.setup();
    api.scratchpadNote.mockResolvedValue(
      savedNote({
        scope: "connection",
        ownerId: connection.id,
        connectionId: connection.id,
        text: "Original text",
      }),
    );
    render(<ScratchpadPane connection={connection} />);
    const editor = await screen.findByLabelText("Connection note");

    fireEvent.change(editor, { target: { value: "Original tex" } });
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    expect(editor).toHaveProperty("value", "Original text");
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true, shiftKey: true });
    expect(editor).toHaveProperty("value", "Original tex");

    await user.click(screen.getByRole("button", { name: "Clear text" }));
    expect(editor).toHaveProperty("value", "");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(editor).toHaveProperty("value", "Original tex");
    await user.click(screen.getByRole("button", { name: "Redo" }));
    expect(editor).toHaveProperty("value", "");
  });

  it("shows the same global note independent of the active connection", async () => {
    const user = userEvent.setup();
    api.scratchpadNote.mockImplementation(
      async (scope: string, ownerId: string): Promise<ScratchpadNote | null> =>
        scope === "global"
          ? savedNote({
              scope: "global",
              ownerId,
              connectionId: null,
              text: "Shared reminder",
            })
          : null,
    );
    render(<ScratchpadPane connection={connection} />);
    await screen.findByLabelText("Connection note");
    await user.click(screen.getByRole("button", { name: "Global note for all connections" }));

    expect(await screen.findByLabelText("Global note")).toHaveProperty("value", "Shared reminder");
    expect(screen.getByText("Shared by every Saved Connection and Workspace")).toBeTruthy();
    expect(api.scratchpadNote).toHaveBeenLastCalledWith("global", "global", null);
    await user.click(screen.getByRole("button", { name: "Delete note" }));
    await user.click(screen.getAllByRole("button", { name: "Delete note" }).at(-1)!);
    await waitFor(() =>
      expect(api.deleteScratchpadNote).toHaveBeenCalledWith("global", "global", null),
    );
  });
});
