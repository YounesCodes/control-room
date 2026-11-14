import "./isolation";
import { expect } from "@wdio/globals";
import { ipc, openLocal, runtime, terminalCommand } from "./helpers";
import { localShellId } from "./platform";
import type { LocalShellCatalog } from "../src/types";

describe("Installed local shells", () => {
  it("opens every installed unelevated shell and keeps its native session independent", async () => {
    const { profiles } = await ipc<LocalShellCatalog>("list_local_shells");
    expect(profiles.some((shell) => shell.id === localShellId)).toBe(true);
    const shells = profiles.filter((shell) => !shell.elevated);
    for (const [index, shell] of shells.entries()) {
      await openLocal(shell.label);
      await terminalCommand(`echo SHELL_${index}_READY`, `SHELL_${index}_READY`);
      expect((await runtime()).sessionIds).toHaveLength(index + 1);
    }
  });
});
