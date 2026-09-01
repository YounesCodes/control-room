import { describe, expect, it } from "vitest";
import { tagBadgeStyle, tagDisplayColor } from "./connection-tag-color";

describe("connection tag colors", () => {
  it("uses one hue for text, a tinted background, and a matching border", () => {
    expect(tagBadgeStyle("#58a6ff")).toEqual({
      color: "#58a6ff",
      backgroundColor: "rgb(88 166 255 / 14%)",
      borderColor: "rgb(88 166 255 / 58%)",
    });
  });

  it("lightens dark selections without replacing their hue with black or white", () => {
    const displayColor = tagDisplayColor("#24292f");
    expect(displayColor).not.toBe("#24292f");
    expect(displayColor).not.toBe("#000000");
    expect(displayColor).not.toBe("#ffffff");
  });
});
