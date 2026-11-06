import { describe, expect, it } from "vitest";
import { parseOptions, registry } from "./ui-review-options.mjs";

describe("UI capture selection", () => {
  it("captures both supported widths unless one is requested", () => {
    expect(parseOptions(["capture", "--scenario", "settings"])).toEqual({
      type: "capture",
      scenario: "settings",
      state: "populated",
      viewport: "all",
    });
    expect(
      parseOptions([
        "capture",
        "--scenario",
        "systemd",
        "--state",
        "error",
        "--viewport",
        "narrow",
      ]),
    ).toMatchObject({ state: "error", viewport: "narrow" });
    expect(registry.viewports.narrow).toEqual({ width: 960, height: 640 });
  });

  it.each([
    ["capture"],
    ["capture", "--scenario", "../settings"],
    ["capture", "--scenario", "toString"],
    ["capture", "--scenario", "settings", "--state", "error"],
    ["capture", "--scenario", "settings", "--viewport", "toString"],
    ["capture", "--scenario", "settings", "--viewport", "../normal"],
    ["capture", "--scenario", "settings", "--headed"],
    ["capture", "--scenario", "settings", "--state"],
    ["motion", "--scenario", "systemd"],
  ])("rejects unsupported or unsafe selections: %j", (...args) => {
    expect(() => parseOptions(args)).toThrow();
  });

  it("lists real scenarios without launching a browser", () => {
    expect(parseOptions(["capture", "--list"]).help).toBe(true);
    expect(parseOptions(["motion", "--help"]).help).toBe(true);
    expect(parseOptions(["motion", "--scenario", "settings"]).type).toBe("motion");
  });
});
