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
import { TerminalScratchpad } from "./TerminalScratchpad";

function NotePopup({ connection }: { connection: SavedConnection }) {
  return (
    <TerminalScratchpad
      terminalScope="connection"
      ownerId={connection.id}
      ownerLabel={connection.displayName}
      canPaste={false}
      onPaste={() => undefined}
      onClose={() => undefined}
    />
  );
}

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
/** The editor renders read-only while its note loads; wait until it accepts edits. */
async function loadedNote(label: string) {
  const editor = await screen.findByLabelText(label);
  await waitFor(() => expect(editor).toHaveProperty("readOnly", false));
  return editor;
}

/** The visible note's save state; the other note stays mounted but hidden. */
function savedLocally() {
  return waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved locally"));
}

function savedNote(input: ScratchpadNoteInput): ScratchpadNote {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    ...input,
    createdAt: "created",
    updatedAt: "updated",
  };
}

describe("Scratchpad note editing", () => {
  it("waits for an in-flight save before deleting and never recreates the note", async () => {
    let finish!: (note: ScratchpadNote) => void;
    api.saveScratchpadNote.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<NotePopup connection={connection} />);
    const editor = await loadedNote("Connection note");
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

  it.each(["pending", "saved"] as const)(
    "keeps %s text when deletion fails, then retries deletion",
    async (saveState) => {
      api.scratchpadNote.mockResolvedValue(
        savedNote({
          scope: "connection",
          ownerId: connection.id,
          connectionId: connection.id,
          text: "keep me",
        }),
      );
      api.deleteScratchpadNote.mockRejectedValueOnce(new Error("database locked"));
      render(<NotePopup connection={connection} />);
      const editor = await loadedNote("Connection note");
      fireEvent.change(editor, { target: { value: "keep newer text" } });
      if (saveState === "saved") {
        await waitFor(() => expect(api.saveScratchpadNote).toHaveBeenCalled(), { timeout: 2_000 });
        await savedLocally();
      }
      // Keep queued deletion in one event turn so it cannot race the debounce.
      fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Delete note" }).at(-1)!);
      if (saveState === "pending") expect(api.saveScratchpadNote).not.toHaveBeenCalled();
      await screen.findByText(/Could not delete the note: database locked/);
      expect(editor).toHaveProperty("value", "keep newer text");
      expect(window.localStorage.getItem(scratchpadDraftKey("connection", connection.id))).toBe(
        saveState === "saved" ? null : "keep newer text",
      );
      await userEvent.click(screen.getAllByRole("button", { name: "Delete note" }).at(-1)!);
      await waitFor(() => expect(editor).toHaveProperty("value", ""));
    },
  );
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
    render(<NotePopup connection={connection} />);
    const editor = await loadedNote("Connection note");
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
    await savedLocally();
    expect(window.localStorage.getItem(scratchpadDraftKey("connection", connection.id))).toBeNull();
  });

  it("retains the latest fallback draft when SQLite autosave fails and retries it", async () => {
    const user = userEvent.setup();
    api.saveScratchpadNote.mockRejectedValueOnce(new Error("disk full"));
    render(<NotePopup connection={connection} />);
    const editor = await loadedNote("Connection note");
    fireEvent.change(editor, { target: { value: "Do not lose this" } });

    await screen.findByText(/Autosave failed.*disk full/, {}, { timeout: 2_000 });
    expect(window.localStorage.getItem(scratchpadDraftKey("connection", connection.id))).toBe(
      "Do not lose this",
    );
    await user.click(screen.getByRole("button", { name: "Retry save" }));
    await savedLocally();
    expect(api.saveScratchpadNote).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(scratchpadDraftKey("connection", connection.id))).toBeNull();
  });

  it("does not overwrite SQLite from a fallback draft until a failed load is retried", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(scratchpadDraftKey("connection", connection.id), "Recovered draft");
    api.scratchpadNote.mockRejectedValueOnce(new Error("database busy"));
    render(<NotePopup connection={connection} />);

    expect(await loadedNote("Connection note")).toHaveProperty("value", "Recovered draft");
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    expect(api.saveScratchpadNote).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Retry load" }));
    await waitFor(() =>
      expect(
        api.scratchpadNote.mock.calls.filter(([scope]) => scope === "connection"),
      ).toHaveLength(2),
    );
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
    render(<NotePopup connection={connection} />);
    const editor = await loadedNote("Connection note");

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
    render(<NotePopup connection={connection} />);
    await loadedNote("Connection note");
    await user.click(screen.getByRole("button", { name: "Global note for all connections" }));

    expect(await screen.findByLabelText("Global note")).toHaveProperty("value", "Shared reminder");
    expect(
      screen
        .getByRole("button", { name: "Global note for all connections" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(api.scratchpadNote).toHaveBeenLastCalledWith("global", "global", null);
    await user.click(screen.getByRole("button", { name: "Delete note" }));
    await user.click(screen.getAllByRole("button", { name: "Delete note" }).at(-1)!);
    await waitFor(() =>
      expect(api.deleteScratchpadNote).toHaveBeenCalledWith("global", "global", null),
    );
  });

  it("switches notes in place without reloading or dropping unsaved edits", async () => {
    const user = userEvent.setup();
    api.scratchpadNote.mockImplementation(
      async (scope: string, ownerId: string): Promise<ScratchpadNote | null> =>
        savedNote({
          scope: scope as ScratchpadNoteInput["scope"],
          ownerId,
          connectionId: scope === "connection" ? ownerId : null,
          text: scope === "global" ? "Shared reminder" : "Host reminder",
        }),
    );
    render(<NotePopup connection={connection} />);
    const connectionEditor = await loadedNote("Connection note");
    const globalEditor = await loadedNote("Global note");
    fireEvent.change(connectionEditor, { target: { value: "Host reminder, edited" } });

    await user.click(screen.getByRole("button", { name: "Global note for all connections" }));
    // Already loaded: the switch shows the global note at once and focuses it.
    expect(screen.getByRole("textbox", { name: "Global note" })).toBe(globalEditor);
    expect(globalEditor).toHaveProperty("value", "Shared reminder");
    expect(document.activeElement).toBe(globalEditor);
    expect(screen.queryByRole("textbox", { name: "Connection note" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Connection note for Host A" }));
    expect(screen.getByRole("textbox", { name: "Connection note" })).toBe(connectionEditor);
    expect(connectionEditor).toHaveProperty("value", "Host reminder, edited");
    expect(screen.getByRole("button", { name: "Undo" })).toHaveProperty("disabled", false);
    expect(api.scratchpadNote).toHaveBeenCalledTimes(2);
  });

  it("keeps the editor layout read-only while a note loads", async () => {
    const loads: ((note: ScratchpadNote | null) => void)[] = [];
    api.scratchpadNote.mockImplementation(() => new Promise((resolve) => loads.push(resolve)));
    render(<NotePopup connection={connection} />);
    const editor = screen.getByRole("textbox", { name: "Connection note" });
    expect(editor).toHaveProperty("readOnly", true);
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    fireEvent.change(editor, { target: { value: "typed too early" } });
    expect(editor).toHaveProperty("value", "");

    for (const load of loads) load(null);
    await waitFor(() => expect(editor).toHaveProperty("readOnly", false));
    expect(screen.getByRole("textbox", { name: "Connection note" })).toBe(editor);
  });
});
