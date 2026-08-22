import { describe, expect, it } from "vitest";
import {
  WORKSPACE_CACHE_TTL_MS,
  emptyCachedList,
  isCacheFresh,
  reconcileSelection,
} from "./workspace-cache";

describe("workspace cache", () => {
  it("treats new and expired data as stale", () => {
    expect(isCacheFresh(emptyCachedList(), 100_000)).toBe(false);
    expect(isCacheFresh({ fetchedAt: 100_000 - WORKSPACE_CACHE_TTL_MS }, 100_000)).toBe(false);
  });

  it("keeps data fresh for thirty seconds", () => {
    expect(isCacheFresh({ fetchedAt: 100_000 - 29_999 }, 100_000)).toBe(true);
  });

  it("repairs a selection that disappeared after refresh", () => {
    const items = [{ id: "first" }, { id: "second" }];
    expect(reconcileSelection(items, "second")).toBe("second");
    expect(reconcileSelection(items, "removed")).toBe("first");
    expect(reconcileSelection([], "removed")).toBeNull();
  });
});
