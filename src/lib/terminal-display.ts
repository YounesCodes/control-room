interface WritableTerminal {
  write(data: string): void;
}

const CLEAR_DISPLAY_SEQUENCE = "\u001b[2J\u001b[3J\u001b[H";

export function clearTerminalDisplay(terminal: WritableTerminal) {
  terminal.write(CLEAR_DISPLAY_SEQUENCE);
}
