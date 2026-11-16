import type { AppUpdateInfo, UpdateFailure } from "../types";

export type AppUpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; info: AppUpdateInfo }
  | { status: "downloading"; info: AppUpdateInfo; downloaded: number; total: number | null }
  | { status: "downloaded"; info: AppUpdateInfo }
  | { status: "installing"; info: AppUpdateInfo }
  | { status: "failed"; info: AppUpdateInfo; failure: UpdateFailure };

export const idleUpdateState: AppUpdateState = { status: "idle" };

export function updateInfo(state: AppUpdateState): AppUpdateInfo | null {
  return "info" in state ? state.info : null;
}

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

export function downloadLabel(downloaded: number, total: number | null): string {
  const percent = downloadPercent(downloaded, total);
  return percent === null ? "Downloading…" : `Downloading ${percent}%`;
}

export function downloadPercent(downloaded: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.floor((downloaded / total) * 100)));
}

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

export function canOpenUpdateDetails(state: AppUpdateState): boolean {
  return state.status !== "idle" && state.status !== "checking";
}

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

export function shouldRunForegroundRefresh(options: {
  enabled: boolean;
  state: AppUpdateState;
  lastCheckedAt: number | null;
  now: number;
  thresholdMs: number;
}): boolean {
  const { enabled, state, lastCheckedAt, now, thresholdMs } = options;
  if (!enabled) return false;
  if (state.status !== "idle") return false;
  if (lastCheckedAt === null) return false;
  return now - lastCheckedAt >= thresholdMs;
}

export const FIRST_CHECK_DELAY_MS = 10_000;
export const PERIODIC_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const SCHEDULER_TICK_INTERVAL_MS = 5 * 60 * 1000;
export const FOREGROUND_REFRESH_AFTER_MS = 15 * 60 * 1000;
