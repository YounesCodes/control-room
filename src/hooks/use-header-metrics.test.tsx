// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeaderMetrics } from "../types";
const mock = vi.hoisted(() => ({ sampleHeaderMetrics: vi.fn() }));
vi.mock("../lib/api", () => ({ api: mock, errorMessage: (value: unknown) => String(value) }));
import { useHeaderMetrics } from "./use-header-metrics";
const sample: HeaderMetrics = {
  sampledAt: new Date().toISOString(),
  cpuPercent: 15,
  memoryTotalKib: 1000,
  memoryAvailableKib: 300,
  gpuPercent: null,
  diskTotalKib: null,
  diskFreeKib: null,
  diskLabel: null,
  uptimeSeconds: 900,
};
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
describe("header sampling lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(sample.sampledAt));
    mock.sampleHeaderMetrics.mockReset();
    mock.sampleHeaderMetrics.mockImplementation(async () => ({
      ...sample,
      sampledAt: new Date().toISOString(),
    }));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it("does no work without a target or any selected metrics", async () => {
    const { rerender } = renderHook(({ target, metrics }) => useHeaderMetrics(target, metrics, 5), {
      initialProps: { target: null as string | null, metrics: ["cpu"] as ("cpu" | "ram")[] },
    });
    await tick(10000);
    expect(mock.sampleHeaderMetrics).not.toHaveBeenCalled();
    rerender({ target: "local", metrics: [] });
    await tick(10000);
    expect(mock.sampleHeaderMetrics).not.toHaveBeenCalled();
  });
  it("uses the local endpoint, polls selected metrics, and stops on unmount", async () => {
    const { result, unmount } = renderHook(() => useHeaderMetrics("local", ["cpu"], 5));
    await tick();
    expect(mock.sampleHeaderMetrics).toHaveBeenCalledWith(null, ["cpu"]);
    expect(result.current.sample).toEqual(sample);
    await tick(5000);
    expect(mock.sampleHeaderMetrics).toHaveBeenCalledTimes(2);
    unmount();
    await tick(10000);
    expect(mock.sampleHeaderMetrics).toHaveBeenCalledTimes(2);
  });
  it("never overlaps slow reads or displays a late reply from a previous host", async () => {
    let resolve!: (value: HeaderMetrics) => void;
    mock.sampleHeaderMetrics.mockReturnValueOnce(
      new Promise<HeaderMetrics>((done) => {
        resolve = done;
      }),
    );
    const { result, rerender } = renderHook(({ target }) => useHeaderMetrics(target, ["cpu"], 2), {
      initialProps: { target: "host-a" },
    });
    await tick(10000);
    expect(mock.sampleHeaderMetrics).toHaveBeenCalledTimes(1);
    rerender({ target: "host-b" });
    expect(result.current.sample).toBeNull();
    await tick(2000);
    expect(mock.sampleHeaderMetrics).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ ...sample, cpuPercent: 90 }));
    expect(result.current.sample).toBeNull();
    await tick(2000);
    expect(mock.sampleHeaderMetrics).toHaveBeenLastCalledWith("host-b", ["cpu"]);
    expect(result.current.sample?.cpuPercent).toBe(15);
  });
  it("treats a malformed sample time as stale and recovers with a valid time", async () => {
    mock.sampleHeaderMetrics.mockResolvedValueOnce({ ...sample, sampledAt: "broken" });
    const { result } = renderHook(() => useHeaderMetrics("local", ["cpu"], 5));
    await tick();
    expect(result.current.stale).toBe(true);
    await tick(5000);
    expect(result.current.stale).toBe(false);
  });
  it.each([0, -1, NaN, Infinity, 0.001, 31])(
    "bounds invalid polling interval %s",
    async (seconds) => {
      renderHook(() => useHeaderMetrics("local", ["cpu"], seconds));
      await tick();
      expect(mock.sampleHeaderMetrics).toHaveBeenCalledTimes(1);
      await tick(1999);
      expect(mock.sampleHeaderMetrics).toHaveBeenCalledTimes(1);
      await tick(3001);
      expect(mock.sampleHeaderMetrics).toHaveBeenCalledTimes(2);
    },
  );
  it("marks a reading stale before a slow refresh finishes", async () => {
    const { result } = renderHook(() => useHeaderMetrics("host-a", ["cpu"], 5));
    await tick();
    mock.sampleHeaderMetrics.mockReturnValueOnce(new Promise(() => {}));
    await tick(8000);
    expect(result.current.sampling).toBe(true);
    expect(result.current.stale).toBe(true);
  });
  it("pauses in hidden windows and refreshes immediately on return", async () => {
    const { result } = renderHook(() => useHeaderMetrics("host-a", ["ram"], 5));
    await tick();
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tick(20000);
    expect(mock.sampleHeaderMetrics).toHaveBeenCalledTimes(1);
    expect(result.current.stale).toBe(true);
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tick();
    expect(mock.sampleHeaderMetrics).toHaveBeenCalledTimes(2);
    expect(result.current.stale).toBe(false);
  });
  it("keeps a failed refresh visibly stale and recovers on the next read", async () => {
    const { result } = renderHook(() => useHeaderMetrics("host-a", ["cpu"], 5));
    await tick();
    mock.sampleHeaderMetrics.mockRejectedValueOnce(new Error("SSH unavailable"));
    await tick(5000);
    expect(result.current.sample).toEqual(sample);
    expect(result.current.stale).toBe(true);
    expect(result.current.error).toContain("SSH unavailable");
    await tick(5000);
    expect(result.current.error).toBeNull();
    expect(result.current.stale).toBe(false);
  });
});
