import { describe, expect, it } from "vitest";
import { buildTerminalTheme, DEFAULT_TERMINAL_COLORS } from "./terminal-theme";

describe("buildTerminalTheme", () => {
  it("maps configurable ANSI colors used by prompts and directory listings", () => {
    const theme = buildTerminalTheme({
      ...DEFAULT_TERMINAL_COLORS,
      terminalForeground: "#eeeeee",
      terminalGreen: "#11aa55",
      terminalBlue: "#3366cc",
    });

    expect(theme.foreground).toBe("#eeeeee");
    expect(theme.cursor).toBe("#eeeeee");
    expect(theme.green).toBe("#11aa55");
    expect(theme.blue).toBe("#3366cc");
    expect(theme.brightBlue).toBe("#5c85d6");
  });
});
