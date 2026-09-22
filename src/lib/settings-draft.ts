import type { AppSettings } from "../types";

/** Arrays are compared by content: a toggle that hides a local terminal builds
 *  a new array every time, and identity would call that a change even when it
 *  put the list back exactly as it was. */
function sameValue(saved: unknown, draft: unknown): boolean {
  if (Array.isArray(saved) || Array.isArray(draft)) {
    return (
      Array.isArray(saved) &&
      Array.isArray(draft) &&
      saved.length === draft.length &&
      saved.every((value, index) => value === draft[index])
    );
  }
  return saved === draft;
}

export function settingsHaveChanges(saved: AppSettings, draft: AppSettings): boolean {
  return (Object.keys(saved) as Array<keyof AppSettings>).some(
    (key) => !sameValue(saved[key], draft[key]),
  );
}
