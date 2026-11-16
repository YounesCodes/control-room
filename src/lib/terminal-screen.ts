import type { Terminal } from "@xterm/xterm";

export interface TerminalView {
  line: string | null;
  alternate: boolean;
  status: string[];
}

export function readTerminalView(terminal: Terminal | null, includeStatus = false): TerminalView {
  const buffer = terminal?.buffer?.active;
  if (!buffer) return { line: null, alternate: false, status: [] };
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  // viewportY may point into scrollback, so read the live screen.
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
