import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const terminalSource = readFileSync(
  new URL("./components/TerminalPane.tsx", import.meta.url),
  "utf8",
);

describe("Workspace pane lifecycle", () => {
  it("remounts stateful panes when the active Workspace changes", () => {
    for (const pane of ["OverviewPane", "ServicesPane", "DockerPane", "LogsPane", "HistoryPane"]) {
      expect(appSource).toMatch(new RegExp(`<${pane}\\s+key=\\{activeWorkspace\\.id\\}`));
    }
  });

  it("resets xterm before starting each replacement Terminal Session", () => {
    const sessionEffect = terminalSource.indexOf(
      "const generation = ++sessionGenerationRef.current",
    );
    const reset = terminalSource.indexOf("terminal.reset()", sessionEffect);
    const start = terminalSource.indexOf(".startSession(", sessionEffect);

    expect(sessionEffect).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(sessionEffect);
    expect(reset).toBeLessThan(start);
  });
});
