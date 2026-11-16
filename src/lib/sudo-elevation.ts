import type { AppSettings, SavedConnection } from "../types";

export type ElevationSource = "global" | "connection" | "off";

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

export function elevationCapabilityNote(passwordlessSudo: boolean | null): string | null {
  if (passwordlessSudo === null) return null;
  return passwordlessSudo
    ? "This account has passwordless sudo, so allowed reads run elevated."
    : "This account is asked for a password by sudo, so allowed reads still run as the connecting account until you retry one with a password.";
}

export function connectionElevationSource(
  settings: AppSettings,
  connection: SavedConnection,
): ElevationSource {
  return elevationSource(settings.globalSudoEnabled, connection.sudoEnabled);
}
