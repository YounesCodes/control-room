import type { Terminal } from "@xterm/xterm";

/** What command activity needs from a rendered terminal. */
export interface TerminalView {
  /** The line the cursor rests on, or null when it cannot be read. */
  line: string | null;
  /** Whether a program owns the screen, as Vim or a coding agent does. */
  alternate: boolean;
  status: string[];
}

/** Read the prompt and, after output, the current status area. Never inspect
 * scrollback or touch xterm's write queue. */
export function readTerminalView(terminal: Terminal | null, includeStatus = false): TerminalView {
  const buffer = terminal?.buffer?.active;
  if (!buffer) return { line: null, alternate: false, status: [] };
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  // Read the live screen, not viewportY, which may point into scrollback.
  // Main-screen agents can draw above unused rows, so discard trailing blank
  // rows before selecting the last twelve lines of their current UI.
  const status: string[] = [];
  if (includeStatus) {
    for (let row = terminal!.rows - 1; row >= 0 && status.length < 12; row--) {
      const text = buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "";
      if (text.trim() || status.length > 0) status.unshift(text);
    }
  }
  return {
    line: line?.translateToString(false, 0, buffer.cursorX) ?? null,
    alternate: buffer.type === "alternate",
    status,
  };
}
