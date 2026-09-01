import { describe, expect, it } from "vitest";
import { tagTextColor } from "./connection-tag-color";

describe("connection tag colors", () => {
  it("chooses readable text for dark and light tag backgrounds", () => {
    expect(tagTextColor("#24292f")).toBe("#ffffff");
    expect(tagTextColor("#f6f8fa")).toBe("#000000");
  });

  it("uses black text on the bright default GitHub label green", () => {
    expect(tagTextColor("#42d17a")).toBe("#000000");
  });
});
