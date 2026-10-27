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
    expect(theme.brightRed).toBe(theme.red);
    expect(theme.brightGreen).toBe(theme.green);
    expect(theme.brightYellow).toBe(theme.yellow);
    expect(theme.brightBlue).toBe(theme.blue);
    expect(theme.brightMagenta).toBe(theme.magenta);
    expect(theme.brightCyan).toBe(theme.cyan);
    expect(theme.brightWhite).toBe(theme.foreground);
  });
});
