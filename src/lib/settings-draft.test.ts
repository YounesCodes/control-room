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
  hiddenLocalShells: [],
};

describe("Settings drafts", () => {
  it("detects unsaved changes without treating an equal copy as dirty", () => {
    expect(settingsHaveChanges(settings, { ...settings })).toBe(false);
    expect(settingsHaveChanges(settings, { ...settings, terminalFontSize: 16 })).toBe(true);
  });

  it("compares a list of hidden local terminals by content, not by identity", () => {
    const hidden: AppSettings = {
      ...settings,
      hiddenLocalShells: ["git-bash", "powershell-7"],
    };
    expect(settingsHaveChanges(settings, hidden)).toBe(true);
    expect(
      settingsHaveChanges(hidden, {
        ...hidden,
        hiddenLocalShells: ["powershell-7", "git-bash"],
      }),
    ).toBe(false);
    expect(settingsHaveChanges(hidden, { ...hidden, hiddenLocalShells: ["command-prompt"] })).toBe(
      true,
    );
    expect(settingsHaveChanges(hidden, { ...hidden, hiddenLocalShells: [] })).toBe(true);
  });

  it("detects a hidden shell added to a legacy payload", () => {
    const legacy = { ...settings } as AppSettings;
    delete (legacy as Partial<AppSettings>).hiddenLocalShells;

    expect(settingsHaveChanges(legacy, { ...legacy, hiddenLocalShells: [] })).toBe(false);
    expect(settingsHaveChanges(legacy, { ...legacy, hiddenLocalShells: ["git-bash"] })).toBe(true);
  });
});
