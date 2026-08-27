import type { AppSettings } from "../types";

export function settingsHaveChanges(saved: AppSettings, draft: AppSettings): boolean {
  return (Object.keys(saved) as Array<keyof AppSettings>).some((key) => saved[key] !== draft[key]);
}
