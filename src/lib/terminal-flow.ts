export const MAX_PENDING_TERMINAL_INPUT_BYTES = 64 * 1024;

type TerminalKeyEvent = Pick<KeyboardEvent, "type" | "ctrlKey" | "shiftKey" | "key">;

export function isControlRoomShortcut(event: TerminalKeyEvent): boolean {
  if (event.type !== "keydown" || !event.ctrlKey) return false;
  const key = event.key.toLowerCase();
  if (!event.shiftKey) return key === "k";
  return key === "t" || key === "n" || key === "w" || key === "r";
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
