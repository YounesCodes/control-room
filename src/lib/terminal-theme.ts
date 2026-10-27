import type { ITheme } from "@xterm/xterm";
import type { AppSettings } from "../types";

type TerminalColorSettings = Pick<
  AppSettings,
  | "terminalForeground"
  | "terminalRed"
  | "terminalGreen"
  | "terminalYellow"
  | "terminalBlue"
  | "terminalMagenta"
  | "terminalCyan"
>;

export const TERMINAL_BACKGROUND = "#000000";

export function buildTerminalTheme(colors: TerminalColorSettings): ITheme {
  return {
    background: TERMINAL_BACKGROUND,
    foreground: colors.terminalForeground,
    cursor: colors.terminalForeground,
    selectionBackground: "#393939",
    // xterm otherwise draws a white line along the empty search-marker rail.
    overviewRulerBorder: "#00000000",
    black: "#151515",
    red: colors.terminalRed,
    green: colors.terminalGreen,
    yellow: colors.terminalYellow,
    blue: colors.terminalBlue,
    magenta: colors.terminalMagenta,
    cyan: colors.terminalCyan,
    white: colors.terminalForeground,
    brightBlack: "#70706d",
    brightRed: colors.terminalRed,
    brightGreen: colors.terminalGreen,
    brightYellow: colors.terminalYellow,
    brightBlue: colors.terminalBlue,
    brightMagenta: colors.terminalMagenta,
    brightCyan: colors.terminalCyan,
    brightWhite: colors.terminalForeground,
  };
}
