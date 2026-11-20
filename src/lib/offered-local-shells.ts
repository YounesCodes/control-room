import type { AdministratorTerminalStatus, LocalShellKind, LocalShellProfile } from "../types";

const ADMINISTRATOR_CAPABLE_KINDS: ReadonlySet<LocalShellKind> = new Set([
  "powershell-7",
  "windows-powershell",
  "command-prompt",
]);

export function offeredLocalShells(
  profiles: LocalShellProfile[],
  hiddenIds: string[],
): LocalShellProfile[] {
  if (hiddenIds.length === 0) return profiles;
  const hidden = new Set(hiddenIds);
  return profiles.filter((profile) => !hidden.has(profile.id));
}

export function defaultLocalShell(
  profiles: LocalShellProfile[],
  defaultId: string | null,
): LocalShellProfile | null {
  const standard = profiles.filter((profile) => !profile.elevated);
  return standard.find((profile) => profile.id === defaultId) ?? standard[0] ?? null;
}

export function needsAdministratorSetup(
  profiles: LocalShellProfile[],
  hiddenIds: string[],
  status: AdministratorTerminalStatus,
): boolean {
  if (status !== "disabled" && status !== "unsupportedMode") return false;
  return offeredLocalShells(profiles, hiddenIds).some(
    (profile) =>
      !profile.elevated &&
      ADMINISTRATOR_CAPABLE_KINDS.has(profile.kind) &&
      !hiddenIds.includes(profile.id + "-administrator"),
  );
}
