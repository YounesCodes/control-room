import { describe, expect, it } from "vitest";
import { settingsHaveChanges } from "./settings-draft";
import type { AppSettings } from "../types";

const settings: AppSettings = {
  terminalFontFamily: "Consolas",
  terminalFontSize: 14,
  terminalScrollback: 10_000,
  terminalForeground: "#ffffff",
  terminalRed: "#ff0000",
  terminalGreen: "#00ff00",
  terminalYellow: "#ffff00",
  terminalBlue: "#0000ff",
  terminalMagenta: "#ff00ff",
  terminalCyan: "#00ffff",
  defaultLogTail: 200,
  globalHistoryEnabled: true,
  globalSudoEnabled: false,
  automaticUpdateChecks: true,
};

describe("Settings drafts", () => {
  it("detects unsaved changes without treating an equal copy as dirty", () => {
    expect(settingsHaveChanges(settings, { ...settings })).toBe(false);
    expect(settingsHaveChanges(settings, { ...settings, terminalFontSize: 16 })).toBe(true);
  });
});
