// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppUpdater } from "./use-app-updater";
import {
  FIRST_CHECK_DELAY_MS,
  FOREGROUND_REFRESH_AFTER_MS,
  PERIODIC_CHECK_INTERVAL_MS,
  SCHEDULER_TICK_INTERVAL_MS,
} from "../lib/app-update";
import { api } from "../lib/api";
import type { AppUpdateInfo } from "../types";

vi.mock("../lib/api", () => ({
  api: {
    checkForUpdate: vi.fn(async () => null),
    currentAppVersion: vi.fn(async () => "0.7.0"),
    pendingUpdateNotice: vi.fn(async () => null),
    dismissUpdateNotice: vi.fn(async () => undefined),
  },
}));

const checkForUpdate = vi.mocked(api.checkForUpdate);

const info: AppUpdateInfo = {
  currentVersion: "0.7.0",
  version: "0.7.1",
  notes: "- A thing",
  publishedAt: "2026-09-06T12:00:00Z",
};

beforeEach(() => {
  vi.useFakeTimers();
  checkForUpdate.mockClear();
  checkForUpdate.mockImplementation(async () => null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("automatic update scheduler", () => {
  it("runs its first check after the startup delay", async () => {
    renderHook(() => useAppUpdater(true));
    expect(checkForUpdate).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    });
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("rechecks about once an hour while the app stays open", async () => {
    renderHook(() => useAppUpdater(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    });
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    // The five minute tick asks repeatedly inside the hour and is always
    // refused, so the spacing is the policy's, not the timer's.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PERIODIC_CHECK_INTERVAL_MS - SCHEDULER_TICK_INTERVAL_MS);
    });
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * SCHEDULER_TICK_INTERVAL_MS);
    });
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("does not recheck while an update is already available", async () => {
    checkForUpdate.mockImplementation(async () => info);
    renderHook(() => useAppUpdater(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    });
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PERIODIC_CHECK_INTERVAL_MS + SCHEDULER_TICK_INTERVAL_MS);
    });
    // Rechecking cannot improve an update the user has not acted on yet.
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("runs nothing automatically while the preference is off", async () => {
    const { result } = renderHook(() => useAppUpdater(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PERIODIC_CHECK_INTERVAL_MS + FIRST_CHECK_DELAY_MS);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(checkForUpdate).not.toHaveBeenCalled();

    // The manual Settings check works regardless of the preference.
    let outcome: Awaited<ReturnType<typeof result.current.checkNow>> | undefined;
    await act(async () => {
      outcome = await result.current.checkNow();
    });
    expect(outcome).toEqual({ outcome: "current" });
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("wakes up promptly when the preference is turned back on", async () => {
    const { rerender } = renderHook(({ enabled }) => useAppUpdater(enabled), {
      initialProps: { enabled: false },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    });
    expect(checkForUpdate).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULER_TICK_INTERVAL_MS);
    });
    // The next tick picks it up, not some future multiple of the interval.
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on focus while the last check is fresh", async () => {
    renderHook(() => useAppUpdater(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    });
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_REFRESH_AFTER_MS - 1);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("refreshes on focus once the last check is stale", async () => {
    renderHook(() => useAppUpdater(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    });
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    // The periodic schedule is nowhere near due; the foreground is.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_REFRESH_AFTER_MS);
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("collapses focus and a scheduler tick into at most one request", async () => {
    renderHook(() => useAppUpdater(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    });
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    await act(async () => {
      // A tick and both foreground events arrive while every one of them is
      // eligible (the hour has passed, the feed is stale). The synchronous
      // in-flight guard lets exactly one of them through.
      await vi.advanceTimersByTimeAsync(PERIODIC_CHECK_INTERVAL_MS + SCHEDULER_TICK_INTERVAL_MS);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });
});
