import { describe, expect, it } from "vitest";
import { chartPath, memoryPercent, sumRates } from "./overview-diagnostics";
describe("diagnostic values and history", () => {
  it("does not convert missing counters to idle readings", () => {
    expect(sumRates([0, 0])).toBe(0);
    expect(sumRates([1, null])).toBeNull();
    expect(sumRates([])).toBeNull();
    expect(sumRates([NaN])).toBeNull();
    expect(sumRates([-1])).toBeNull();
    expect(
      memoryPercent({
        totalKib: 100,
        availableKib: 25,
        buffersKib: null,
        cacheKib: null,
        swapTotalKib: null,
        swapFreeKib: null,
      }),
    ).toBe(75);
    expect(memoryPercent(undefined)).toBeNull();
  });
  it("positions real points by time and breaks lines at missing readings", () => {
    const path = chartPath(
      [
        { time: 0, value: 0 },
        { time: 25, value: 50 },
        { time: 50, value: null },
        { time: 100, value: 100 },
      ],
      0,
      100,
      100,
    );
    expect(path).toBe("M2.0,76.0 L101.0,40.0  M398.0,4.0");
  });
});
