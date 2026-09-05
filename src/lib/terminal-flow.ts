export const MAX_PENDING_TERMINAL_INPUT_BYTES = 64 * 1024;

type TerminalKeyEvent = Pick<KeyboardEvent, "type" | "ctrlKey" | "shiftKey" | "key">;

type ShortcutTarget = {
  closest?: (selectors: string) => unknown;
};

export function isWorkspaceShortcutBlocked(
  target: EventTarget | null,
  applicationOverlayOpen: boolean,
): boolean {
  if (applicationOverlayOpen) return true;
  const candidate = target as ShortcutTarget | null;
  if (!candidate?.closest) return false;
  if (candidate.closest(".xterm")) return false;
  return Boolean(
    candidate.closest("input, textarea, select, [contenteditable='true'], [role='dialog']"),
  );
}

export function isControlRoomShortcut(event: TerminalKeyEvent): boolean {
  if (event.type !== "keydown") return false;
  if (!event.ctrlKey) return false;
  const key = event.key.toLowerCase();
  if (!event.shiftKey) return false;
  return key === "t" || key === "w" || key === "r" || key === "p";
}

/// Who owns a right click inside the terminal.
///
/// `terminal` means the program running in the pty asked for the mouse and
/// should receive the click. `ignore` means the gesture was not a pointer right
/// click at all, which is how the context-menu key reaches this: it raises the
/// same event with no button behind it, and taking that over would remove a
/// keyboard route to the menu for no reason.
export type TerminalRightClickAction = "copy" | "paste" | "terminal" | "ignore";

type TerminalRightClick = {
  button: number;
  hasSelection: boolean;
  mouseTrackingMode: string;
};

/// Decides what a right click means, and nothing else.
///
/// This answers only the clipboard question. Whether the webview's own menu is
/// suppressed is a separate decision made at the event, because tying the two
/// together is what let the menu appear whenever Control Room declined the
/// gesture.
///
/// A selection wins over everything: it is the one case where the user has
/// already said which text they mean, and a program that reads the mouse has
/// not asked for that selection to be thrown away.
export function terminalRightClickAction(click: TerminalRightClick): TerminalRightClickAction {
  if (click.button !== 2) return "ignore";
  if (click.hasSelection) return "copy";
  if (click.mouseTrackingMode === "none") return "paste";
  return "terminal";
}

export class BoundedByteQueue {
  private readonly chunks: Uint8Array[] = [];
  private retainedBytes = 0;

  constructor(private readonly maxBytes = MAX_PENDING_TERMINAL_INPUT_BYTES) {}

  get byteCount(): number {
    return this.retainedBytes;
  }

  enqueue(bytes: Uint8Array): boolean {
    if (bytes.byteLength > this.maxBytes - this.retainedBytes) return false;
    this.chunks.push(bytes);
    this.retainedBytes += bytes.byteLength;
    return true;
  }

  drain(): Uint8Array[] {
    const pending = this.chunks.splice(0);
    this.retainedBytes = 0;
    return pending;
  }

  clear(): void {
    this.chunks.length = 0;
    this.retainedBytes = 0;
  }
}
