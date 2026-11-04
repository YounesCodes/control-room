import type { SystemdInspection } from "../types";

export function systemdInspection(
  id: string,
  properties: Record<string, string> = {},
  text = "",
): SystemdInspection {
  return {
    id,
    properties,
    text,
    warnings: [],
    truncated: false,
    collectedAt: "2026-11-01T10:00:00Z",
  };
}
