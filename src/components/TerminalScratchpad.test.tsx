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
  it("follows local and remote pane owners without mixing note scopes or resetting Global", async () => {
    api.scratchpadNote.mockImplementation(async (scope: string, ownerId: string) =>
      savedNote({
        scope: scope as ScratchpadNoteInput["scope"],
        ownerId,
        connectionId: scope === "connection" ? ownerId : null,
        text: `${scope}:${ownerId}`,
      }),
    );
    const props = {
      ownerLabel: "Selected pane",
      canPaste: true,
      onPaste: vi.fn(),
      onClose: vi.fn(),
    };
    const view = render(
      <TerminalScratchpad {...props} terminalScope="local" ownerId={workspaceId} />,
    );
    expect(await screen.findByLabelText("Terminal note")).toHaveProperty(
      "value",
      `local:${workspaceId}`,
    );
    view.rerender(
      <TerminalScratchpad {...props} terminalScope="connection" ownerId={connectionId} />,
    );
    expect(await screen.findByLabelText("Connection note")).toHaveProperty(
      "value",
      `connection:${connectionId}`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Global note for all connections" }));
    expect(await screen.findByLabelText("Global note")).toHaveProperty("value", "global:global");
    view.rerender(<TerminalScratchpad {...props} terminalScope="local" ownerId={workspaceId} />);
    expect(screen.getByLabelText("Global note")).toHaveProperty("value", "global:global");
    fireEvent.click(screen.getByRole("button", { name: "Terminal note for Selected pane" }));
    expect(await screen.findByLabelText("Terminal note")).toHaveProperty(
      "value",
      `local:${workspaceId}`,
    );
  });
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    api.scratchpadNote.mockResolvedValue(null);
    api.saveScratchpadNote.mockImplementation((input: ScratchpadNoteInput) =>
      Promise.resolve(savedNote(input)),
    );
  });

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

  it("opens on the terminal note when a reopen cancels the closing transition", async () => {
    const props = {
      terminalScope: "local" as const,
      ownerId: workspaceId,
      ownerLabel: "PowerShell 7",
      canPaste: true,
      onPaste: () => undefined,
      onClose: () => undefined,
    };
    const view = render(<TerminalScratchpad {...props} />);
    await screen.findByLabelText("Terminal note");
    fireEvent.click(screen.getByRole("button", { name: "Global note for all connections" }));
    await screen.findByLabelText("Global note");
    view.rerender(<TerminalScratchpad {...props} closing />);
    view.rerender(<TerminalScratchpad {...props} closing={false} />);
    const editor = screen.getByLabelText("Terminal note");
    expect(editor.closest("[hidden]")).toBeNull();
    expect(screen.getByLabelText("Global note").closest("[hidden]")).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(editor));
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

  it("copies and pastes the selection, or the whole note when nothing is selected", async () => {
    const user = userEvent.setup();
    const clipboardWrite = installClipboardSpy(user);
    const onPaste = vi.fn();
    api.scratchpadNote.mockResolvedValue(
      savedNote({
        scope: "local",
        ownerId: workspaceId,
        connectionId: null,
        text: "make\nmake install",
      }),
    );
    mount({ onPaste });
    const editor = (await screen.findByLabelText("Terminal note")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("make\nmake install"));

    const select = (start: number, end: number) => {
      editor.focus();
      editor.setSelectionRange(start, end);
      fireEvent.keyUp(editor);
    };

    select(5, 17);
    await user.click(await screen.findByRole("button", { name: "Copy selection" }));
    expect(clipboardWrite).toHaveBeenLastCalledWith("make install");
    expect(screen.getByRole("button", { name: "Copied selection" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Paste selection" }));
    expect(onPaste).toHaveBeenLastCalledWith("make install");

    select(2, 2);
    await user.click(await screen.findByRole("button", { name: "Paste into terminal" }));
    expect(onPaste).toHaveBeenLastCalledWith("make\nmake install");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy(), {
      timeout: 3000,
    });
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(clipboardWrite).toHaveBeenLastCalledWith("make\nmake install");
    expect(screen.getByRole("button", { name: "Copied note" })).toBeTruthy();
  });

  it("copies the selection or the caret's line with Ctrl+C and right-click", async () => {
    const user = userEvent.setup();
    const clipboardWrite = installClipboardSpy(user);
    api.scratchpadNote.mockResolvedValue(
      savedNote({
        scope: "local",
        ownerId: workspaceId,
        connectionId: null,
        text: "first\nsecond line\n\nlast",
      }),
    );
    mount();
    const editor = (await screen.findByLabelText("Terminal note")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.readOnly).toBe(false));

    editor.setSelectionRange(9, 9);
    expect(fireEvent.keyDown(editor, { key: "c", ctrlKey: true })).toBe(false);
    await waitFor(() => expect(clipboardWrite).toHaveBeenLastCalledWith("second line"));
    expect(await screen.findByRole("button", { name: "Copied line" })).toBeTruthy();

    editor.setSelectionRange(0, 3);
    fireEvent.mouseDown(editor, { button: 2 });
    expect(fireEvent.contextMenu(editor)).toBe(false);
    await waitFor(() => expect(clipboardWrite).toHaveBeenLastCalledWith("fir"));
    expect(await screen.findByRole("button", { name: "Copied selection" })).toBeTruthy();

    editor.setSelectionRange(1, 1);
    fireEvent.mouseDown(editor, { button: 2 });
    editor.setSelectionRange(6, 12);
    expect(fireEvent.contextMenu(editor)).toBe(false);
    await waitFor(() => expect(clipboardWrite).toHaveBeenLastCalledWith("second line"));
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([6, 6]);

    clipboardWrite.mockClear();
    editor.setSelectionRange(18, 18);
    fireEvent.mouseDown(editor, { button: 2 });
    expect(fireEvent.contextMenu(editor)).toBe(true);
    expect(fireEvent.keyDown(editor, { key: "c", ctrlKey: true })).toBe(true);
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it("reopens a note with the caret or selection where it was left", async () => {
    const ownerId = "44444444-4444-4444-8444-444444444444";
    api.scratchpadNote.mockResolvedValue(
      savedNote({
        scope: "local",
        ownerId,
        connectionId: null,
        text: "one\ntwo\nthree",
      }),
    );
    const first = mount({ ownerId });
    const editor = (await screen.findByLabelText("Terminal note")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("one\ntwo\nthree"));
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([0, 0]);
    editor.focus();
    editor.setSelectionRange(4, 7);
    fireEvent.keyUp(editor);
    first.unmount();

    mount({ ownerId });
    const reopened = (await screen.findByLabelText("Terminal note")) as HTMLTextAreaElement;
    await waitFor(() => expect(reopened.value).toBe("one\ntwo\nthree"));
    expect([reopened.selectionStart, reopened.selectionEnd]).toEqual([4, 7]);
  });

  it("keeps keyboard undo in the compact editor", async () => {
    await mount();
    const editor = (await screen.findByLabelText("Terminal note")) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "line" } });
    expect(editor.value).toBe("line");
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    expect(editor.value).toBe("");
  });
});
