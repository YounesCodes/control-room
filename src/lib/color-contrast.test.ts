import { describe, expect, it } from "vitest";
import { contrastRatio } from "./color-contrast";

describe("contrastRatio", () => {
  it("measures readable and unreadable terminal colors", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#222222", "#050505")).toBeLessThan(4.5);
  });
});
