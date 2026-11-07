/// Geometry and span math for a terminal selection made while the program in
/// the pty reads the mouse.
///
/// xterm.js cannot keep such a selection alive by itself: when a program
/// requests drag or motion reporting, every mouse move during a forced
/// (Shift) drag is forwarded to the pty, and each forwarded report counts as
/// user input, which clears the selection being dragged — before it is ever
/// finished. The pane owns the gesture end to end and applies the result
/// through xterm's public selection APIs, which fire the same
/// `onSelectionChange` events a program-independent selection would.

/// A point in the visible terminal grid. Rows are 0-based viewport rows.
export interface SelectionPoint {
  column: number;
  row: number;
}

/// The granularity xterm uses for repeated clicks: character, word, or line.
export type SelectionGranularity = "character" | "word" | "line";

/// The part of an xterm terminal the selection gesture reads and drives.
export interface SelectionTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: {
    active: {
      viewportY: number;
      getLine(index: number): { translateToString(trimRight: boolean): string } | undefined;
    };
  };
  select(column: number, row: number, length: number): void;
  selectLines(start: number, end: number): void;
  clearSelection(): void;
}

interface SelectionBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/// Repeated clicks select characters, then words, then whole lines, matching
/// the granularity a plain xterm selection uses for the same clicks.
export function selectionGranularity(detail: number): SelectionGranularity {
  if (detail >= 3) return "line";
  if (detail === 2) return "word";
  return "character";
}

/// Converts a viewport point to a 0-based grid cell. Coordinates outside the
/// grid are clamped onto the nearest cell, so a drag that ends outside the
/// terminal still selects through the edge it crossed.
export function selectionPointFromClient(
  bounds: SelectionBounds,
  cols: number,
  rows: number,
  clientX: number,
  clientY: number,
): SelectionPoint {
  const cellWidth = bounds.width / Math.max(cols, 1);
  const cellHeight = bounds.height / Math.max(rows, 1);
  const column = clamp(Math.floor((clientX - bounds.left) / cellWidth), 0, cols - 1);
  const row = clamp(Math.floor((clientY - bounds.top) / cellHeight), 0, rows - 1);
  return { column, row };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/// The word boundaries xterm uses by default: its `wordSeparator` option,
/// where the leading space covers the whitespace runs terminal output makes
/// words out of.
const WORD_SEPARATORS = " ()[]{}'\",`";

function isWordSeparator(character: string): boolean {
  return /\s/.test(character) || WORD_SEPARATORS.includes(character);
}

/// The half-open cell span a word click in xterm selects, reproduced from its
/// SelectionService. A click on a space takes the run of spaces around it.
/// Any other click keeps the clicked cell and extends across both neighbors
/// until a separator appears, so a click next to a bracket keeps it. A click
/// past the line's content has no word.
function wordAt(line: string, column: number): { start: number; end: number } {
  const clicked = line[column];
  if (clicked === undefined) return { start: column, end: column };
  let start = column;
  let end = column;
  if (clicked === " ") {
    while (start > 0 && line[start - 1] === " ") start -= 1;
    while (end + 1 < line.length && line[end + 1] === " ") end += 1;
  } else {
    while (start > 0 && !isWordSeparator(line[start - 1])) start -= 1;
    while (end + 1 < line.length && !isWordSeparator(line[end + 1])) end += 1;
  }
  return { start, end: end + 1 };
}

/// Applies the span between two grid points to the terminal, at the requested
/// granularity. The cell span is half-open: [start, end) along one line.
export function applyTerminalSelection(
  terminal: SelectionTerminal,
  anchor: SelectionPoint,
  target: SelectionPoint,
  granularity: SelectionGranularity,
): void {
  const bufferRow = (row: number) => row + terminal.buffer.active.viewportY;
  let startColumn = anchor.column;
  let endColumn = target.column;
  let startRow = anchor.row;
  let endRow = target.row;
  if (endRow < startRow || (endRow === startRow && endColumn < startColumn)) {
    [startColumn, endColumn] = [endColumn, startColumn];
    [startRow, endRow] = [endRow, startRow];
  }
  if (granularity === "line" || startRow !== endRow) {
    // Line granularity, and any span that crosses a row, select whole rows:
    // xterm's public selection API expresses only one run on one line, so the
    // crossing span collapses to the lines it covers.
    terminal.selectLines(bufferRow(startRow), bufferRow(endRow));
    return;
  }
  if (granularity === "word") {
    const line = terminal.buffer.active.getLine(bufferRow(startRow))?.translateToString(true) ?? "";
    const start = wordAt(line, startColumn);
    const end = wordAt(line, clamp(endColumn, 0, Math.max(line.length - 1, 0)));
    startColumn = start.start;
    endColumn = end.end;
    if (endColumn <= startColumn) return;
  } else {
    endColumn += 1;
  }
  endColumn = clamp(endColumn, startColumn + 1, terminal.cols);
  terminal.select(startColumn, bufferRow(startRow), endColumn - startColumn);
}
