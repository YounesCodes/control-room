import { describe, expect, it } from "vitest";
import { offeredLocalShells } from "./offered-local-shells";
import type { LocalShellProfile } from "../types";

function profile(id: string, elevated = false): LocalShellProfile {
  return {
    id,
    label: id,
    kind: "powershell-7",
    elevated,
  };
}

const installed = [profile("powershell-7"), profile("git-bash"), profile("command-prompt")];

describe("Offered local shells", () => {
  it("offers every installed shell when nothing is hidden", () => {
    expect(offeredLocalShells(installed, [])).toEqual(installed);
  });

  it("drops the shells the user turned off and keeps the rest in order", () => {
    expect(offeredLocalShells(installed, ["powershell-7"]).map((shell) => shell.id)).toEqual([
      "git-bash",
      "command-prompt",
    ]);
  });

  it("hides an administrator profile without hiding the shell it is a variant of", () => {
    const administrator = profile("powershell-7-administrator", true);
    const offered = offeredLocalShells(
      [...installed, administrator],
      ["powershell-7-administrator"],
    );

    expect(offered.map((shell) => shell.id)).toEqual([
      "powershell-7",
      "git-bash",
      "command-prompt",
    ]);
  });

  it("ignores a hidden id that names nothing installed", () => {
    expect(offeredLocalShells(installed, ["wt.exe"])).toEqual(installed);
  });
});
