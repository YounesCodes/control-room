export const MAX_PENDING_TERMINAL_INPUT_BYTES = 64 * 1024;

type TerminalRightClickAction = "copy" | "paste" | "terminal" | "ignore";

type TerminalRightClick = {
  button: number;
  hasSelection: boolean;
  mouseTrackingMode: string;
  isCodex: boolean;
};

export function terminalRightClickAction(click: TerminalRightClick): TerminalRightClickAction {
  if (click.button !== 2) return "ignore";
  if (click.hasSelection) return "copy";
  if (click.isCodex || click.mouseTrackingMode === "none") return "paste";
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

export function trimTrailingLineBreaks(text: string): string {
  return text.replace(/[\r\n]+$/, "");
}

export function pasteRunsLines(text: string, bracketedPaste: boolean): boolean {
  return !bracketedPaste && /[\r\n]/.test(text);
}
