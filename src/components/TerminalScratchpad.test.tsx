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

import { TerminalScratchpad } from "./TerminalScratchpad";
import type { ScratchpadNote, ScratchpadNoteInput } from "../types";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const connectionId = "11111111-1111-4111-8111-111111111111";

function savedNote(input: ScratchpadNoteInput): ScratchpadNote {
  return { id: "33333333-3333-4333-8333-333333333333", ...input, createdAt: "c", updatedAt: "u" };
}

function mount(overrides: Partial<Parameters<typeof TerminalScratchpad>[0]> = {}) {
  return render(
    <TerminalScratchpad
      terminalScope="local"
      ownerId={workspaceId}
      ownerLabel="PowerShell 7"
      canPaste
      onPaste={() => undefined}
      onClose={() => undefined}
      {...overrides}
    />,
  );
}

describe("Terminal Scratchpad popover", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    api.scratchpadNote.mockResolvedValue(null);
    api.saveScratchpadNote.mockImplementation((input: ScratchpadNoteInput) =>
      Promise.resolve(savedNote(input)),
    );
  });

  /// user-event's setup() installs its own clipboard stub on the navigator, so
  /// the spy has to replace it after that, not before.
  function installClipboardSpy(user: ReturnType<typeof userEvent.setup>) {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: write },
      configurable: true,
    });
    void user;
    return write;
  }

  it("edits the terminal's own note and pastes it into the terminal on request", async () => {
    const user = userEvent.setup();
    const clipboardWrite = installClipboardSpy(user);
    const onPaste = vi.fn();
    mount({ onPaste });
    const editor = await screen.findByLabelText("Terminal note");
    await user.type(editor, "cargo build --release");
    await waitFor(() =>
      expect(api.saveScratchpadNote).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "local",
          ownerId: workspaceId,
          connectionId: null,
          text: "cargo build --release",
        }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(clipboardWrite).toHaveBeenCalledWith("cargo build --release");
    await user.click(screen.getByRole("button", { name: "Paste into terminal" }));
    expect(onPaste).toHaveBeenCalledWith("cargo build --release");
  });

  it("switches between the terminal note and the global note without mixing them", async () => {
    const user = userEvent.setup();
    api.scratchpadNote.mockImplementation((scope: string, ownerId: string) =>
      Promise.resolve(
        scope === "global"
          ? savedNote({ scope: "global", ownerId: "global", connectionId: null, text: "shared" })
          : savedNote({
              scope: "local",
              ownerId,
              connectionId: null,
              text: "tab only",
            }),
      ),
    );
    mount();
    const editor = (await screen.findByLabelText("Terminal note")) as HTMLTextAreaElement;
    expect(editor.value).toBe("tab only");
    await user.click(screen.getByRole("button", { name: "Global note for all connections" }));
    const globalEditor = (await screen.findByLabelText("Global note")) as HTMLTextAreaElement;
    expect(globalEditor.value).toBe("shared");
    await user.type(globalEditor, "!");
    await waitFor(() =>
      expect(api.saveScratchpadNote).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "global", ownerId: "global", connectionId: null }),
      ),
    );
    expect(api.saveScratchpadNote.mock.calls.some((call) => call[0].scope === "local")).toBe(false);
  });

  it("uses the connection note for a remote terminal", async () => {
    const user = userEvent.setup();
    mount({
      terminalScope: "connection",
      ownerId: connectionId,
      ownerLabel: "Host A",
    });
    const editor = await screen.findByLabelText("Connection note");
    await user.type(editor, "restart api");
    await waitFor(() =>
      expect(api.saveScratchpadNote).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "connection",
          ownerId: connectionId,
          connectionId,
          text: "restart api",
        }),
      ),
    );
    expect(
      screen
        .getByRole("button", { name: "Connection note for Host A" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("closes on Escape and refuses to paste while the terminal cannot receive text", async () => {
    const onClose = vi.fn();
    mount({ canPaste: false, onClose });
    await screen.findByLabelText("Terminal note");
    expect(
      (screen.getByRole("button", { name: "Paste into terminal" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Scratchpad" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the page Scratchpad's keyboard undo in the compact editor", async () => {
    await mount();
    const editor = (await screen.findByLabelText("Terminal note")) as HTMLTextAreaElement;
    // One edit, not one keystroke, so a single Ctrl+Z returns to the empty note.
    fireEvent.change(editor, { target: { value: "line" } });
    expect(editor.value).toBe("line");
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    expect(editor.value).toBe("");
  });
});
