import { describe, expect, it } from "vitest";
import {
  CHECK_INTERVAL_MS,
  canOpenUpdateDetails,
  downloadLabel,
  downloadPercent,
  idleUpdateState,
  shouldRunAutomaticCheck,
  updateIndicatorAccessibleName,
  updateIndicatorLabel,
  updateInfo,
  type AppUpdateState,
} from "./app-update";
import type { AppUpdateInfo } from "../types";

const info: AppUpdateInfo = {
  currentVersion: "0.6.1",
  version: "0.7.0",
  notes: "- Added a thing",
  publishedAt: "2026-09-05T17:00:00Z",
};

describe("update indicator label", () => {
  it("shows nothing at all while up to date or checking", () => {
    // A quiet background check must leave the titlebar exactly as it was.
    expect(updateIndicatorLabel(idleUpdateState)).toBeNull();
    expect(updateIndicatorLabel({ status: "checking" })).toBeNull();
  });

  it("announces an available update in two words", () => {
    expect(updateIndicatorLabel({ status: "available", info })).toBe("Update available");
  });

  it("counts a download with a known size", () => {
    const state: AppUpdateState = {
      status: "downloading",
      info,
      downloaded: 420,
      total: 1000,
    };
    expect(updateIndicatorLabel(state)).toBe("Downloading 42%");
  });

  it("does not invent a percentage when the size is unknown", () => {
    const state: AppUpdateState = { status: "downloading", info, downloaded: 4200, total: null };
    expect(updateIndicatorLabel(state)).toBe("Downloading…");
    expect(downloadPercent(4200, null)).toBeNull();
    // A zero total would divide to nothing useful, so it is treated as unknown.
    expect(downloadLabel(10, 0)).toBe("Downloading…");
  });

  it("asks for a restart once the bytes are ready", () => {
    expect(updateIndicatorLabel({ status: "downloaded", info })).toBe("Restart to update");
    expect(updateIndicatorLabel({ status: "installing", info })).toBe("Installing…");
  });

  it("does not park a failure in the titlebar", () => {
    // The update is still available and still retryable; the reason belongs in
    // the popover rather than permanently in the window chrome.
    const state: AppUpdateState = {
      status: "failed",
      info,
      failure: { kind: "download", message: "Could not reach the update endpoint." },
    };
    expect(updateIndicatorLabel(state)).toBe("Update available");
  });

  it("names the application and version for screen readers", () => {
    expect(updateIndicatorAccessibleName({ status: "available", info })).toBe(
      "Update available: Control Room 0.7.0",
    );
    expect(updateIndicatorAccessibleName({ status: "downloaded", info })).toBe(
      "Restart to update to Control Room 0.7.0",
    );
    expect(updateIndicatorAccessibleName(idleUpdateState)).toBeNull();
  });

  it("clamps a percentage that overshoots", () => {
    expect(downloadPercent(1200, 1000)).toBe(100);
    expect(downloadPercent(-5, 1000)).toBe(0);
  });
});

describe("update details", () => {
  it("opens only once there is something to describe", () => {
    expect(canOpenUpdateDetails(idleUpdateState)).toBe(false);
    expect(canOpenUpdateDetails({ status: "checking" })).toBe(false);
    expect(canOpenUpdateDetails({ status: "available", info })).toBe(true);
  });

  it("carries its update through every state that has one", () => {
    expect(updateInfo(idleUpdateState)).toBeNull();
    expect(updateInfo({ status: "downloaded", info })?.version).toBe("0.7.0");
  });
});

describe("automatic check schedule", () => {
  const base = {
    state: idleUpdateState,
    lastCheckedAt: null,
    now: 1_000_000,
    intervalMs: CHECK_INTERVAL_MS,
  };

  it("respects the Settings preference", () => {
    expect(shouldRunAutomaticCheck({ ...base, enabled: true })).toBe(true);
    expect(shouldRunAutomaticCheck({ ...base, enabled: false })).toBe(false);
  });

  it("waits twelve hours between checks", () => {
    const lastCheckedAt = 1_000_000;
    expect(
      shouldRunAutomaticCheck({
        ...base,
        enabled: true,
        lastCheckedAt,
        now: lastCheckedAt + CHECK_INTERVAL_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldRunAutomaticCheck({
        ...base,
        enabled: true,
        lastCheckedAt,
        now: lastCheckedAt + CHECK_INTERVAL_MS,
      }),
    ).toBe(true);
  });

  it("never starts a second check on top of live update work", () => {
    for (const state of [
      { status: "checking" } as const,
      { status: "available", info } as const,
      { status: "downloading", info, downloaded: 1, total: 2 } as const,
      { status: "downloaded", info } as const,
      { status: "installing", info } as const,
    ]) {
      expect(shouldRunAutomaticCheck({ ...base, enabled: true, state, lastCheckedAt: null })).toBe(
        false,
      );
    }
  });

  it("stays eligible after a failure instead of latching off", () => {
    // A failed automatic check returns the state to idle and records the time,
    // so the next interval tries again rather than retrying in a loop.
    const failedAt = 500_000;
    expect(
      shouldRunAutomaticCheck({
        ...base,
        enabled: true,
        lastCheckedAt: failedAt,
        now: failedAt + 1000,
      }),
    ).toBe(false);
    expect(
      shouldRunAutomaticCheck({
        ...base,
        enabled: true,
        lastCheckedAt: failedAt,
        now: failedAt + CHECK_INTERVAL_MS,
      }),
    ).toBe(true);
  });
});
