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
  if (event.key === "F11") return true;
  if (!event.ctrlKey) return false;
  const key = event.key.toLowerCase();
  if (!event.shiftKey) return false;
  return key === "t" || key === "n" || key === "w" || key === "r" || key === "p";
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
