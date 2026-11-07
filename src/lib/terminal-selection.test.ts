import { describe, expect, it } from "vitest";
import {
  applyTerminalSelection,
  selectionGranularity,
  selectionPointFromClient,
  type SelectionTerminal,
} from "./terminal-selection";

interface SelectionRecorder extends SelectionTerminal {
  runs: string[];
}

function terminalFixture(lines: string[], cols = 20, rows = 4): SelectionRecorder {
  const runs: string[] = [];
  const terminal: SelectionRecorder = {
    cols,
    rows,
    runs,
    buffer: {
      active: {
        viewportY: 0,
        getLine: (index: number) =>
          lines[index] === undefined ? undefined : { translateToString: () => lines[index] },
      },
    },
    select: (column, row, length) => {
      runs.push(`select ${column} ${row} ${length}`);
    },
    selectLines: (start, end) => {
      runs.push(`selectLines ${start} ${end}`);
    },
    clearSelection: () => {
      runs.push("clear");
    },
  };
  return terminal;
}

describe("selectionGranularity", () => {
  it("maps click counts to character, word, and line", () => {
    expect(selectionGranularity(1)).toBe("character");
    expect(selectionGranularity(2)).toBe("word");
    expect(selectionGranularity(3)).toBe("line");
    expect(selectionGranularity(7)).toBe("line");
  });
});

describe("selectionPointFromClient", () => {
  const bounds = { left: 0, top: 0, width: 200, height: 80 };

  it("converts a viewport point to a zero-based cell", () => {
    expect(selectionPointFromClient(bounds, 20, 4, 15, 25)).toEqual({ column: 1, row: 1 });
  });

  it("clamps points outside the grid onto the nearest cell", () => {
    expect(selectionPointFromClient(bounds, 20, 4, -40, 200)).toEqual({ column: 0, row: 3 });
    expect(selectionPointFromClient(bounds, 20, 4, 999, -40)).toEqual({ column: 19, row: 0 });
  });
});

describe("applyTerminalSelection", () => {
  it("applies an inclusive character span on one line", () => {
    const terminal = terminalFixture(["first line alpha"]);
    applyTerminalSelection(terminal, { column: 2, row: 1 }, { column: 6, row: 1 }, "character");
    expect(terminal.runs).toEqual(["select 2 1 5"]);
  });

  it("normalizes a drag made backwards", () => {
    const terminal = terminalFixture(["first line alpha"]);
    applyTerminalSelection(terminal, { column: 6, row: 1 }, { column: 2, row: 1 }, "character");
    expect(terminal.runs).toEqual(["select 2 1 5"]);
  });

  it("extends a word drag to the words under both ends", () => {
    const terminal = terminalFixture(["first line alpha"]);
    applyTerminalSelection(terminal, { column: 2, row: 0 }, { column: 9, row: 0 }, "word");
    // "first" under the first end, "line" under the second, and everything
    // between them.
    expect(terminal.runs).toEqual(["select 0 0 10"]);
  });

  it("selects a single word when both ends share it", () => {
    const terminal = terminalFixture(["first line alpha"]);
    applyTerminalSelection(terminal, { column: 7, row: 0 }, { column: 9, row: 0 }, "word");
    expect(terminal.runs).toEqual(["select 6 0 4"]);
  });

  it("selects the run of spaces a word click lands on", () => {
    const terminal = terminalFixture(["first  line??"]);
    applyTerminalSelection(terminal, { column: 6, row: 0 }, { column: 6, row: 0 }, "word");
    expect(terminal.runs).toEqual(["select 5 0 2"]);
  });

  it("selects a word click's neighbors up to xterm's separators", () => {
    const terminal = terminalFixture(["run(1) done"]);
    applyTerminalSelection(terminal, { column: 3, row: 0 }, { column: 3, row: 0 }, "word");
    // The bracket beside "run" is part of the word xterm selects here.
    expect(terminal.runs).toEqual(["select 0 0 5"]);
  });

  it("keeps a word drag past the line's content from selecting anything", () => {
    const terminal = terminalFixture(["first line alpha"], 20, 4);
    applyTerminalSelection(terminal, { column: 17, row: 0 }, { column: 17, row: 0 }, "word");
    expect(terminal.runs).toEqual([]);
  });

  it("selects whole lines across rows", () => {
    const terminal = terminalFixture(["first line alpha", "second line beta"]);
    applyTerminalSelection(terminal, { column: 2, row: 0 }, { column: 9, row: 1 }, "character");
    expect(terminal.runs).toEqual(["selectLines 0 1"]);
  });

  it("swaps a backwards multi-row drag before selecting its lines", () => {
    const terminal = terminalFixture(["first line alpha", "second line beta"]);
    applyTerminalSelection(terminal, { column: 2, row: 1 }, { column: 9, row: 0 }, "character");
    expect(terminal.runs).toEqual(["selectLines 0 1"]);
  });

  it("applies line granularity to a single row", () => {
    const terminal = terminalFixture(["first line alpha"]);
    applyTerminalSelection(terminal, { column: 2, row: 1 }, { column: 4, row: 1 }, "line");
    expect(terminal.runs).toEqual(["selectLines 1 1"]);
  });

  it("clamps a character span to the grid width", () => {
    const terminal = terminalFixture(["first line alpha"], 20, 4);
    applyTerminalSelection(terminal, { column: 18, row: 3 }, { column: 19, row: 3 }, "character");
    expect(terminal.runs).toEqual(["select 18 3 2"]);
  });
});
