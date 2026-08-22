import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("Workspace pane lifecycle", () => {
  it("remounts stateful panes when the active Workspace changes", () => {
    for (const pane of ["OverviewPane", "ServicesPane", "DockerPane", "LogsPane", "HistoryPane"]) {
      expect(appSource).toMatch(new RegExp(`<${pane}\\s+key=\\{activeWorkspace\\.id\\}`));
    }
  });
});
