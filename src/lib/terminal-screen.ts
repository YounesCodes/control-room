import type { Terminal } from "@xterm/xterm";

/** What command activity needs from a rendered terminal. */
export interface TerminalView {
  /** The line the cursor rests on, or null when it cannot be read. */
  line: string | null;
  /** Whether a program owns the screen, as Vim or a coding agent does. */
  alternate: boolean;
}

/** Reads only the cursor line and which buffer is active.
 *
 * The line the cursor rests on is where the shell's prompt lives, so it is the
 * one part of the screen that reports whether the shell is waiting. Reading it
 * costs nothing beside a render and never touches xterm's write queue. */
export function readTerminalView(terminal: Terminal | null): TerminalView {
  const buffer = terminal?.buffer?.active;
  if (!buffer) return { line: null, alternate: false };
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  return {
    line: line?.translateToString(false, 0, buffer.cursorX) ?? null,
    alternate: buffer.type === "alternate",
  };
}
