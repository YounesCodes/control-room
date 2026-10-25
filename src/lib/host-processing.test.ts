import { describe, expect, it, vi } from "vitest";
import { beginHostOperation, hostProcessing } from "./host-processing";

describe("host processing", () => {
  it("keeps overlapping requests busy until the last one finishes", () => {
    const changed = vi.fn();
    const unsubscribe = hostProcessing.subscribe(changed);
    const first = beginHostOperation("alpha");
    const second = beginHostOperation("alpha");
    const other = beginHostOperation("beta");
    first();
    first();
    expect(hostProcessing.getSnapshot()).toEqual(new Set(["alpha", "beta"]));
    second();
    expect(hostProcessing.getSnapshot()).toEqual(new Set(["beta"]));
    other();
    expect(hostProcessing.getSnapshot().size).toBe(0);
    expect(changed).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it("ignores reads without a saved host and retains a stable snapshot", () => {
    const before = hostProcessing.getSnapshot();
    beginHostOperation(null)();
    beginHostOperation(undefined)();
    expect(hostProcessing.getSnapshot()).toBe(before);
  });
});
