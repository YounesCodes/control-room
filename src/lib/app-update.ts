import type { AppUpdateInfo, UpdateFailure } from "../types";

/**
 * The update lifecycle as one value.
 *
 * A set of independent booleans would let "downloading" and "downloaded" both
 * be true, or let progress survive a state it does not belong to. A tagged
 * union makes those states unrepresentable, and every piece of data hangs off
 * the one state that owns it.
 */
export type AppUpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; info: AppUpdateInfo }
  | { status: "downloading"; info: AppUpdateInfo; downloaded: number; total: number | null }
  | { status: "downloaded"; info: AppUpdateInfo }
  | { status: "installing"; info: AppUpdateInfo }
  | { status: "failed"; info: AppUpdateInfo; failure: UpdateFailure };

export const idleUpdateState: AppUpdateState = { status: "idle" };

/** The update this state is about, when there is one. */
export function updateInfo(state: AppUpdateState): AppUpdateInfo | null {
  return "info" in state ? state.info : null;
}

/**
 * The titlebar label, or null to show nothing at all.
 *
 * Nothing is shown while idle or checking: a quiet background check that finds
 * nothing must leave the titlebar exactly as it was. A failed download reverts
 * to "Update available" rather than parking "Update failed" in the titlebar
 * forever; the popover is where the reason belongs, and the update really is
 * still available to retry.
 */
export function updateIndicatorLabel(state: AppUpdateState): string | null {
  switch (state.status) {
    case "idle":
    case "checking":
      return null;
    case "available":
    case "failed":
      return "Update available";
    case "downloading":
      return downloadLabel(state.downloaded, state.total);
    case "downloaded":
      return "Restart to update";
    case "installing":
      return "Installing…";
  }
}

/** Percentage only when the endpoint gave a length worth dividing by. */
export function downloadLabel(downloaded: number, total: number | null): string {
  const percent = downloadPercent(downloaded, total);
  return percent === null ? "Downloading…" : `Downloading ${percent}%`;
}

export function downloadPercent(downloaded: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.floor((downloaded / total) * 100)));
}

/**
 * The accessible name for the titlebar control.
 *
 * The visible label is deliberately terse, so the name carries what the icon
 * and two words cannot: which application and which version.
 */
export function updateIndicatorAccessibleName(state: AppUpdateState): string | null {
  const label = updateIndicatorLabel(state);
  if (label === null) return null;
  const info = updateInfo(state);
  if (!info) return label;
  switch (state.status) {
    case "downloading":
      return `${label}: Control Room ${info.version}`;
    case "downloaded":
      return `Restart to update to Control Room ${info.version}`;
    case "installing":
      return `Installing Control Room ${info.version}`;
    default:
      return `Update available: Control Room ${info.version}`;
  }
}

/** Whether opening the details popover makes sense in this state. */
export function canOpenUpdateDetails(state: AppUpdateState): boolean {
  return state.status !== "idle" && state.status !== "checking";
}

/**
 * Whether an automatic check should run now.
 *
 * Kept pure so the schedule is testable without timers. A check is skipped
 * while the preference is off, while anything is already in flight, and while
 * an update is already waiting: rechecking cannot improve any of those.
 */
export function shouldRunAutomaticCheck(options: {
  enabled: boolean;
  state: AppUpdateState;
  lastCheckedAt: number | null;
  now: number;
  intervalMs: number;
}): boolean {
  const { enabled, state, lastCheckedAt, now, intervalMs } = options;
  if (!enabled) return false;
  if (state.status !== "idle") return false;
  if (lastCheckedAt === null) return true;
  return now - lastCheckedAt >= intervalMs;
}

/** How long the app waits before its first check, and between later ones. */
export const FIRST_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
