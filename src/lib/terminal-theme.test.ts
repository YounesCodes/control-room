import { describe, expect, it } from "vitest";
import { buildTerminalTheme } from "./terminal-theme";

describe("buildTerminalTheme", () => {
  it("maps configurable ANSI colors used by prompts and directory listings", () => {
    const theme = buildTerminalTheme({
      terminalForeground: "#eeeeee",
      terminalRed: "#ff6f7d",
      terminalGreen: "#11aa55",
      terminalYellow: "#e8c56c",
      terminalBlue: "#3366cc",
      terminalMagenta: "#c793ff",
      terminalCyan: "#65d4d1",
    });

    expect(theme.foreground).toBe("#eeeeee");
    expect(theme.cursor).toBe("#eeeeee");
    expect(theme.green).toBe("#11aa55");
    expect(theme.blue).toBe("#3366cc");
    expect(theme.brightBlue).toBe("#5c85d6");
  });
});
