interface ClearableTerminal {
  clear(): void;
}

/// Wipes the scrollback and everything above the cursor, keeping the line the
/// cursor sits on as the new first line.
///
/// The prompt is the one thing a clear must not eat. A shell draws its prompt
/// once and only redraws it when it is asked for input again, so erasing the
/// whole display (`ESC [ 2J 3J H`) leaves an empty terminal until the next
/// keystroke makes the line editor repaint. Clearing around the cursor line
/// instead keeps the prompt, and anything typed after it, on screen.
export function clearTerminalDisplay(terminal: ClearableTerminal) {
  terminal.clear();
}
