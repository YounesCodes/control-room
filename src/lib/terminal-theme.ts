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

function brighten(hex: string) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16));
  const bright = channels.map((channel) => Math.round(channel + (255 - channel) * 0.2));
  return `#${bright.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function buildTerminalTheme(colors: TerminalColorSettings): ITheme {
  return {
    background: "#000000",
    foreground: colors.terminalForeground,
    cursor: colors.terminalForeground,
    selectionBackground: "#393939",
    black: "#151515",
    red: colors.terminalRed,
    green: colors.terminalGreen,
    yellow: colors.terminalYellow,
    blue: colors.terminalBlue,
    magenta: colors.terminalMagenta,
    cyan: colors.terminalCyan,
    white: colors.terminalForeground,
    brightBlack: "#70706d",
    brightRed: brighten(colors.terminalRed),
    brightGreen: brighten(colors.terminalGreen),
    brightYellow: brighten(colors.terminalYellow),
    brightBlue: brighten(colors.terminalBlue),
    brightMagenta: brighten(colors.terminalMagenta),
    brightCyan: brighten(colors.terminalCyan),
    brightWhite: "#ffffff",
  };
}
