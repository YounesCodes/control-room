import { describe, expect, it } from "vitest";
import { spatialGraphNeighbor } from "./graph-navigation";

describe("spatial graph navigation", () => {
  const nodes = [
    { id: "right", x: 300, y: 100 },
    { id: "down", x: 100, y: 300 },
    { id: "center", x: 100, y: 100 },
    { id: "left", x: -100, y: 100 },
    { id: "up", x: 100, y: -100 },
  ];
  it.each(["Up", "Down", "Left", "Right"] as const)(
    "moves %s based on positions rather than array order",
    (direction) => {
      expect(spatialGraphNeighbor(`Arrow${direction}`, "center", nodes)).toBe(
        direction.toLowerCase(),
      );
      expect(spatialGraphNeighbor(`Arrow${direction}`, "center", [...nodes].reverse())).toBe(
        direction.toLowerCase(),
      );
    },
  );
  it("prefers an aligned neighbor over a nearby diagonal and resolves ties consistently", () => {
    const candidates = [
      ...nodes,
      { id: "diagonal", x: 160, y: 190 },
      { id: "another-right", x: 300, y: 100 },
    ];
    expect(spatialGraphNeighbor("ArrowRight", "center", candidates)).toBe("another-right");
  });
  it("does not wrap or invent a destination when there is no node in that direction", () => {
    expect(spatialGraphNeighbor("ArrowLeft", "left", nodes)).toBeNull();
    expect(spatialGraphNeighbor("ArrowUp", "up", nodes)).toBeNull();
    expect(spatialGraphNeighbor("ArrowRight", "missing", nodes)).toBeNull();
    expect(spatialGraphNeighbor("ArrowDown", "center", [])).toBeNull();
  });
});
