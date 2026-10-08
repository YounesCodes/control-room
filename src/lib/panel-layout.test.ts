import { describe, expect, it } from "vitest";
import { clampPanelSize, restorePanelSizes } from "./panel-layout";
import { persistWorkspaceState } from "./workspace-persistence";

describe("saved panel layout", () => {
  it("accepts old payloads and discards malformed sizes", () => {
    for (const value of [undefined, null, [], "bad"]) expect(restorePanelSizes(value)).toEqual({});
    expect(
      restorePanelSizes({
        connections: 500,
        "sidebar:hosts": 850,
        "content:overview": 100,
        "split:Docker": 420.4,
        "content:ports": Infinity,
        "split:Services": "bad",
        unknown: 10,
      }),
    ).toEqual({
      connections: 480,
      "sidebar:hosts": 800,
      "content:overview": 360,
      "split:Docker": 420,
    });
  });
  it("clamps the visible width without replacing a saved preference", () => {
    const sizes = { connections: 480, "sidebar:hosts": 300, "content:overview": 1200 };
    expect(clampPanelSize(sizes["content:overview"], 360, 600)).toBe(600);
    expect(clampPanelSize(sizes["sidebar:hosts"], 96, 200)).toBe(200);
    const persisted = persistWorkspaceState([], null, [], sizes);
    expect(restorePanelSizes(JSON.parse(JSON.stringify(persisted)).panelSizes)).toEqual(sizes);
    expect(persistWorkspaceState([], null, [], {}).panelSizes).toEqual({});
  });
});
