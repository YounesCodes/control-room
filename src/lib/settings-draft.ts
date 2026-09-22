import type { AppSettings } from "../types";

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
    if (key === "hiddenLocalShells") return !sameStringSet(saved[key], draft[key]);
    return saved[key] !== draft[key];
  });
}
