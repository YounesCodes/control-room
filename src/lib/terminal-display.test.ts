import { describe, expect, it, vi } from "vitest";
import { clearTerminalDisplay } from "./terminal-display";

describe("clearTerminalDisplay", () => {
  it("clears around the cursor line so the prompt survives", () => {
    const terminal = { clear: vi.fn(), write: vi.fn() };

    clearTerminalDisplay(terminal);

    expect(terminal.clear).toHaveBeenCalledOnce();
    // Erasing the display would take the prompt with it and leave the pane
    // blank until the shell was given a reason to redraw it.
    expect(terminal.write).not.toHaveBeenCalled();
  });
});
