import { describe, expect, it } from "vitest";
import {
  defaultLocalShell,
  needsAdministratorSetup,
  offeredLocalShells,
} from "./offered-local-shells";
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
  it("never automatically selects an administrator shell", () => {
    const admin = profile("powershell-7-administrator", true);
    expect(defaultLocalShell([admin, ...installed], admin.id)).toEqual(installed[0]);
    expect(defaultLocalShell([admin], null)).toBeNull();
    expect(defaultLocalShell(installed, null)).toEqual(installed[0]);
  });
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

describe("Administrator setup", () => {
  it("requires an enabled shell and administrator variant that support setup", () => {
    const bash = { ...profile("git-bash"), kind: "git-bash" } as LocalShellProfile;
    const shells = [profile("powershell-7"), bash];
    expect(needsAdministratorSetup([bash], [], "disabled")).toBe(false);
    expect(needsAdministratorSetup(shells, ["powershell-7"], "disabled")).toBe(false);
    expect(needsAdministratorSetup(shells, ["powershell-7-administrator"], "disabled")).toBe(false);
    expect(needsAdministratorSetup(shells, [], "disabled")).toBe(true);
    expect(needsAdministratorSetup(shells, [], "unsupportedMode")).toBe(true);
    expect(needsAdministratorSetup(shells, [], "available")).toBe(false);
    expect(needsAdministratorSetup(shells, [], "unsupportedWindows")).toBe(false);
  });
});
