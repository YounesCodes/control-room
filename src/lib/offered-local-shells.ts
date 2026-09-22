import type { LocalShellProfile } from "../types";

/**
 * The local shells the launchers offer: every profile this machine has, except
 * the ones turned off in Settings.
 *
 * Hiding is presentation only. It never removes a profile from the catalog, so
 * a Workspace already running that shell keeps restoring after a restart, and
 * a hidden id that names nothing here is ignored rather than treated as an
 * error: the setting outlives an uninstall, and turning a shell back on should
 * not be blocked by an entry for something that is no longer installed.
 */
export function offeredLocalShells(
  profiles: LocalShellProfile[],
  hiddenIds: string[],
): LocalShellProfile[] {
  if (hiddenIds.length === 0) return profiles;
  const hidden = new Set(hiddenIds);
  return profiles.filter((profile) => !hidden.has(profile.id));
}
