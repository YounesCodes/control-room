import { describe, expect, it, vi } from "vitest";
import { clearTerminalDisplay } from "./terminal-display";

describe("clearTerminalDisplay", () => {
  it("erases the viewport and scrollback before moving the cursor home", () => {
    const write = vi.fn();

    clearTerminalDisplay({ write });

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith("\u001b[2J\u001b[3J\u001b[H");
  });
});
