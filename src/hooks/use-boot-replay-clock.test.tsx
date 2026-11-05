// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBootReplayClock } from "./use-boot-replay-clock";

const MINUTE_US = 60_000_000;
const TWO_MINUTES_US = 2 * MINUTE_US;

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useBootReplayClock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
  });

  function setup(durationUs = TWO_MINUTES_US) {
    return renderHook(
      (props: { durationUs?: number } = {}) =>
        useBootReplayClock({ durationUs: props.durationUs ?? durationUs }),
      { initialProps: {} as { durationUs?: number } },
    );
  }

  it("advances the virtual clock from measured wall time at the chosen speed", () => {
    const { result } = setup();
    act(() => result.current.play());
    advance(1000);
    // About one second of virtual time has passed at 1x; frame cadence may
    // round the very last frame, so the assertion tolerates one interval.
    expect(result.current.position()).toBeGreaterThan(900_000);
    expect(result.current.position()).toBeLessThanOrEqual(1_100_000);
    expect(result.current.playing).toBe(true);
  });

  it("keeps the position when the speed changes and scales the new frames", () => {
    const { result } = setup();
    act(() => result.current.play());
    advance(1000);
    const beforeSpeedChange = result.current.position();
    act(() => result.current.setSpeed(5));
    expect(result.current.position()).toBe(beforeSpeedChange);
    expect(result.current.speed).toBe(5);
    advance(1000);
    expect(result.current.position() - beforeSpeedChange).toBeGreaterThan(4_000_000);
  });

  it("pauses exactly, seeks deterministically, and reveals nothing early", () => {
    const { result } = setup();
    act(() => result.current.play());
    advance(1000);
    act(() => result.current.pause());
    const pausedAt = result.current.position();
    advance(5000);
    expect(result.current.position()).toBe(pausedAt);
    act(() => result.current.seek(2_000_000));
    expect(result.current.position()).toBe(2_000_000);
    expect(result.current.playing).toBe(false);
  });

  it("restarts from zero without losing the playing state", () => {
    const { result } = setup();
    act(() => result.current.play());
    advance(2000);
    act(() => result.current.restart());
    expect(result.current.position()).toBe(0);
    expect(result.current.playing).toBe(true);
    advance(500);
    expect(result.current.position()).toBeGreaterThan(400_000);
  });

  it("completes at the window end, stops, and replays from zero", () => {
    const { result } = setup(2_000_000); // a two-second window keeps the test fast
    act(() => result.current.play());
    advance(3000);
    expect(result.current.position()).toBe(2_000_000);
    expect(result.current.complete).toBe(true);
    expect(result.current.playing).toBe(false);
    advance(3000);
    expect(result.current.position()).toBe(2_000_000);
    act(() => result.current.play());
    expect(result.current.position()).toBe(0);
    expect(result.current.complete).toBe(false);
  });

  it("clamps the position when the window shrinks", () => {
    const view = setup(TWO_MINUTES_US);
    act(() => view.result.current.seek(MINUTE_US));
    expect(view.result.current.position()).toBe(MINUTE_US);
    act(() => view.result.current.seek(TWO_MINUTES_US + 1));
    expect(view.result.current.position()).toBe(TWO_MINUTES_US);
    view.rerender({ durationUs: 30_000_000 });
    expect(view.result.current.positionUs).toBe(30_000_000);
    expect(view.result.current.position()).toBe(30_000_000);
  });

  it("rejects speeds outside the supported ladder", () => {
    const { result } = setup();
    act(() => result.current.setSpeed(3));
    expect(result.current.speed).toBe(1);
  });

  it("suspends playback when the window is hidden", () => {
    const { result } = setup();
    act(() => result.current.play());
    expect(result.current.playing).toBe(true);
    act(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.playing).toBe(false);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });
});
