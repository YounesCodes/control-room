import type { AppSettings, SavedConnection } from "../types";

/**
 * Why a Saved Connection is or is not allowed to run Structured Operations
 * under sudo.
 */
export type ElevationSource = "global" | "connection" | "off";

/**
 * The global setting is an override rather than a default: while it is on,
 * every host runs elevated regardless of its own flag, which is what allowing
 * sudo everywhere means. That is why "global" outranks "connection" here.
 */
export function elevationSource(
  globalEnabled: boolean,
  connectionEnabled: boolean,
): ElevationSource {
  if (globalEnabled) return "global";
  return connectionEnabled ? "connection" : "off";
}

export function elevationAllowed(globalEnabled: boolean, connectionEnabled: boolean): boolean {
  return elevationSource(globalEnabled, connectionEnabled) !== "off";
}

/** True when the per-host control has nothing left to decide. */
export function perHostControlLocked(globalEnabled: boolean): boolean {
  return globalEnabled;
}

export function elevationSummary(source: ElevationSource): string {
  switch (source) {
    case "global":
      return "Settings allows sudo for every Saved Connection, so this host is already covered.";
    case "connection":
      return "Structured Operations on this host run under sudo when the account has passwordless sudo.";
    default:
      return "Structured Operations run as the connecting account. You can still elevate one request at a time when it hits a permission error.";
  }
}

export function connectionElevationSource(
  settings: AppSettings,
  connection: SavedConnection,
): ElevationSource {
  return elevationSource(settings.globalSudoEnabled, connection.sudoEnabled);
}
