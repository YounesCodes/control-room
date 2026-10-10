import type { AppSettings } from "../types";
import { DEFAULT_HEADER_METRICS } from "./header-metrics";

function sameStringSet(saved: unknown, draft: unknown): boolean {
  const savedValues = Array.isArray(saved) ? new Set(saved) : new Set();
  const draftValues = Array.isArray(draft) ? new Set(draft) : new Set();
  return (
    savedValues.size === draftValues.size &&
    [...savedValues].every((value) => draftValues.has(value))
  );
}

export function settingsHaveChanges(saved: AppSettings, draft: AppSettings): boolean {
  const keys = new Set<keyof AppSettings>([
    ...(Object.keys(saved) as Array<keyof AppSettings>),
    ...(Object.keys(draft) as Array<keyof AppSettings>),
  ]);
  return [...keys].some((key) => {
    if (key === "hostMetricsEnabled") return (saved[key] ?? false) !== (draft[key] ?? false);
    if (key === "hostMetricsIntervalSeconds") return (saved[key] ?? 5) !== (draft[key] ?? 5);
    if (key === "hostMetrics")
      return !sameStringSet(
        saved[key] ?? DEFAULT_HEADER_METRICS,
        draft[key] ?? DEFAULT_HEADER_METRICS,
      );
    if (key === "localTerminalMode") return (saved[key] ?? false) !== (draft[key] ?? false);
    if (key === "defaultLocalShellId") return (saved[key] || null) !== (draft[key] || null);
    if (key === "hiddenLocalShells") return !sameStringSet(saved[key], draft[key]);
    return saved[key] !== draft[key];
  });
}
