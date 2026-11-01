// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverviewDiagnostics } from "../types";
import { diagnostics } from "../test/app-fixtures";
const mock = vi.hoisted(() => ({ sampleOverviewDiagnostics: vi.fn() }));
vi.mock("../lib/api", () => ({ api: mock, errorMessage: (value: unknown) => String(value) }));
import { useOverviewDiagnostics } from "./use-overview-diagnostics";
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  mock.sampleOverviewDiagnostics.mockReset();
  mock.sampleOverviewDiagnostics.mockImplementation(async (_target, workloads) => ({
    ...diagnostics(),
    workloads: workloads ? diagnostics().workloads : null,
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("Overview collection lifecycle", () => {
  it("waits for a retiring header read without showing a host failure", async () => {
    mock.sampleOverviewDiagnostics.mockRejectedValueOnce(
      new Error("Previous reading for this host is still finishing"),
    );
    const { result } = renderHook(() => useOverviewDiagnostics("a", true, 5));
    await tick();
    expect(result.current.error).toBeNull();
    expect(result.current.sample).toBeNull();
    await tick(1000);
    expect(result.current.sample?.cpuPercent).toBe(24);
  });
  it("bounds history by count and age, and collects inventory at most every 30 seconds", async () => {
    const { result, rerender } = renderHook(
      ({ seconds }) => useOverviewDiagnostics("a", true, seconds),
      { initialProps: { seconds: 2 } },
    );
    await tick(260_000);
    expect(result.current.history).toHaveLength(120);
    expect(
      mock.sampleOverviewDiagnostics.mock.calls.slice(1, 15).every((call) => call[1] === false),
    ).toBe(true);
    expect(mock.sampleOverviewDiagnostics.mock.calls[15][1]).toBe(true);
    expect(result.current.workloads?.services?.length).toBe(2);
    rerender({ seconds: 10 });
    await tick(400_000);
    expect(result.current.history.length).toBeLessThanOrEqual(31);
  });
  it("stops when hidden, inactive, or unmounted and clears history across pauses", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ active }) => useOverviewDiagnostics("a", active, 5),
      { initialProps: { active: false } },
    );
    await tick(10_000);
    expect(mock.sampleOverviewDiagnostics).not.toHaveBeenCalled();
    rerender({ active: true });
    await tick();
    expect(result.current.history).toHaveLength(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await tick(30_000);
    expect(mock.sampleOverviewDiagnostics).toHaveBeenCalledTimes(1);
    expect(result.current.history).toHaveLength(0);
    expect(result.current.stale).toBe(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await tick();
    expect(result.current.history).toHaveLength(1);
    rerender({ active: false });
    await tick(30_000);
    expect(mock.sampleOverviewDiagnostics).toHaveBeenCalledTimes(2);
    unmount();
    await tick(30_000);
    expect(mock.sampleOverviewDiagnostics).toHaveBeenCalledTimes(2);
  });
  it("never overlaps reads and discards a retired host response", async () => {
    let finish!: (sample: OverviewDiagnostics) => void;
    mock.sampleOverviewDiagnostics.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      ({ target }) => useOverviewDiagnostics(target, true, 2),
      { initialProps: { target: "a" } },
    );
    await tick(20_000);
    expect(mock.sampleOverviewDiagnostics).toHaveBeenCalledTimes(1);
    rerender({ target: "b" });
    await tick(4000);
    expect(mock.sampleOverviewDiagnostics).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ...diagnostics(), cpuPercent: 99 }));
    expect(result.current.sample).toBeNull();
    await tick(2000);
    expect(result.current.sample?.cpuPercent).toBe(24);
    expect(mock.sampleOverviewDiagnostics).toHaveBeenLastCalledWith("b", true);
  });
  it("retains failed readings as stale and starts a new history after recovery", async () => {
    const { result } = renderHook(() => useOverviewDiagnostics("a", true, 5));
    await tick();
    mock.sampleOverviewDiagnostics.mockRejectedValueOnce(new Error("SSH lost"));
    await tick(5000);
    expect(result.current.stale).toBe(true);
    expect(result.current.error).toContain("SSH lost");
    expect(result.current.sample?.cpuPercent).toBe(24);
    await tick(5000);
    expect(result.current.stale).toBe(false);
    expect(result.current.history).toHaveLength(1);
  });
  it("drops hidden in-flight replies and does not invent readings with invalid timestamps", async () => {
    let finish!: (sample: OverviewDiagnostics) => void;
    mock.sampleOverviewDiagnostics.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      ({ active }) => useOverviewDiagnostics("a", active, 5),
      { initialProps: { active: true } },
    );
    rerender({ active: false });
    await act(async () => finish(diagnostics()));
    expect(result.current.sample).toBeNull();
    mock.sampleOverviewDiagnostics.mockResolvedValueOnce({
      ...diagnostics(),
      sampledAt: "invalid",
    });
    rerender({ active: true });
    await tick();
    expect(result.current.stale).toBe(true);
    expect(result.current.history).toHaveLength(0);
  });
  it("marks a delayed request stale and retries inventory on an explicit refresh", async () => {
    const { result } = renderHook(() => useOverviewDiagnostics("a", true, 5));
    await tick();
    mock.sampleOverviewDiagnostics.mockReturnValueOnce(new Promise(() => {}));
    await tick(36_000);
    expect(result.current.stale).toBe(true);
  });
  it("uses the configured interval and refreshes workload inventory on demand", async () => {
    const { result } = renderHook(() => useOverviewDiagnostics("a", true, 10));
    await tick();
    await tick(9999);
    expect(mock.sampleOverviewDiagnostics).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(mock.sampleOverviewDiagnostics).toHaveBeenLastCalledWith("a", false);
    act(() => result.current.refresh());
    await tick();
    expect(mock.sampleOverviewDiagnostics).toHaveBeenLastCalledWith("a", true);
  });
});
