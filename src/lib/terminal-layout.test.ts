import { describe, expect, it } from "vitest";
import {
  createTerminalLayout,
  getTerminalLayoutIds,
  getTerminalPaneRects,
  getResponsiveTerminalPaneRects,
  getResponsiveTerminalGeometry,
  resizeTerminalLayout,
  pruneTerminalLayout,
  removeTerminalFromLayout,
  selectTerminalTab,
  splitTerminalLayout,
} from "./terminal-layout";

describe("terminal pane tree", () => {
  it("resizes each split independently without changing terminal membership", () => {
    const pair = splitTerminalLayout(createTerminalLayout("local"), "local", "ssh", "vertical");
    const nested = splitTerminalLayout(pair, "ssh", "logs", "horizontal");
    const resized = resizeTerminalLayout(resizeTerminalLayout(nested, "", 0.6), "second", 0.7);
    expect(getTerminalLayoutIds(resized)).toEqual(["local", "ssh", "logs"]);
    expect(getTerminalPaneRects(resized)).toEqual({
      local: { left: 0, top: 0, width: 60, height: 100 },
      ssh: { left: 60, top: 0, width: 40, height: 70 },
      logs: { left: 60, top: 70, width: 40, height: 30 },
    });
    const geometry = getResponsiveTerminalGeometry(resized, { width: 1200, height: 800 });
    expect(
      geometry.dividers.map(({ path, direction, position }) => ({ path, direction, position })),
    ).toEqual([
      { path: "", direction: "vertical", position: 720 },
      { path: "second", direction: "horizontal", position: 560 },
    ]);
    expect(getTerminalPaneRects(resizeTerminalLayout(resized, "second", 0.5)).ssh.height).toBe(50);
  });

  it("temporarily constrains saved proportions and aligns dividers with responsive splits", () => {
    const pair = splitTerminalLayout(createTerminalLayout("local"), "local", "ssh", "vertical");
    const layout = resizeTerminalLayout(pair, "", 0.9);
    const small = getResponsiveTerminalGeometry(layout, { width: 500, height: 700 });
    expect(small.dividers[0].direction).toBe("horizontal");
    expect(small.panes.local.height).toBe(80);
    expect(small.panes.ssh.top).toBe(80);
    expect(small.dividers[0].position).toBe(560);
    expect(getResponsiveTerminalPaneRects(layout, { width: 3000, height: 800 }).local.width).toBe(
      90,
    );
    expect(layout).toMatchObject({ ratio: 0.9, direction: "vertical" });
  });

  it("keeps remaining split sizes after a terminal is closed or pruned", () => {
    const pair = splitTerminalLayout(createTerminalLayout("a"), "a", "b", "vertical");
    const nested = splitTerminalLayout(pair, "b", "c", "horizontal");
    const resized = resizeTerminalLayout(resizeTerminalLayout(nested, "", 0.6), "second", 0.7);
    for (const remaining of [
      removeTerminalFromLayout(resized, "a"),
      pruneTerminalLayout(resized, new Set(["b", "c"])),
    ]) {
      expect(remaining).toMatchObject({ ratio: 0.7, direction: "horizontal" });
      expect(getTerminalPaneRects(remaining!).b.height).toBe(70);
      expect(
        getResponsiveTerminalGeometry(remaining!, { width: 1200, height: 800 }).dividers[0].path,
      ).toBe("");
    }
  });

  it("ignores invalid paths and nonfinite ratios and bounds extreme sizes", () => {
    const layout = splitTerminalLayout(createTerminalLayout("a"), "a", "b", "vertical");
    expect(resizeTerminalLayout(layout, "missing", 0.6)).toBe(layout);
    expect(resizeTerminalLayout(layout, "first", 0.6)).toBe(layout);
    expect(resizeTerminalLayout(layout, "", NaN)).toBe(layout);
    expect(resizeTerminalLayout(layout, "", Infinity)).toBe(layout);
    expect(resizeTerminalLayout(layout, "", -1)).toMatchObject({ ratio: 0.05 });
    expect(resizeTerminalLayout(layout, "", 2)).toMatchObject({ ratio: 0.95 });
  });

  it("splits the focused pane vertically into side-by-side leaves", () => {
    const layout = splitTerminalLayout(
      createTerminalLayout("debian"),
      "debian",
      "ubuntu",
      "vertical",
    );

    expect(getTerminalLayoutIds(layout)).toEqual(["debian", "ubuntu"]);
    expect(getTerminalPaneRects(layout)).toEqual({
      debian: { left: 0, top: 0, width: 50, height: 100 },
      ubuntu: { left: 50, top: 0, width: 50, height: 100 },
    });
  });

  it("splits only the focused leaf horizontally", () => {
    const vertical = splitTerminalLayout(
      createTerminalLayout("debian"),
      "debian",
      "ubuntu",
      "vertical",
    );
    const nested = splitTerminalLayout(vertical, "ubuntu", "docker", "horizontal");

    expect(getTerminalPaneRects(nested)).toEqual({
      debian: { left: 0, top: 0, width: 50, height: 100 },
      ubuntu: { left: 50, top: 0, width: 50, height: 50 },
      docker: { left: 50, top: 50, width: 50, height: 50 },
    });
  });

  it("stacks a nested side-by-side split before either terminal becomes too narrow", () => {
    const vertical = splitTerminalLayout(
      createTerminalLayout("debian"),
      "debian",
      "ubuntu",
      "vertical",
    );
    const nested = splitTerminalLayout(vertical, "ubuntu", "docker", "vertical");

    expect(getResponsiveTerminalPaneRects(nested, { width: 744, height: 560 })).toEqual({
      debian: { left: 0, top: 0, width: 50, height: 100 },
      ubuntu: { left: 50, top: 0, width: 50, height: 50 },
      docker: { left: 50, top: 50, width: 50, height: 50 },
    });
  });

  it("restores the requested side-by-side split when the window has room", () => {
    const vertical = splitTerminalLayout(
      createTerminalLayout("debian"),
      "debian",
      "ubuntu",
      "vertical",
    );
    const nested = splitTerminalLayout(vertical, "ubuntu", "docker", "vertical");

    expect(getResponsiveTerminalPaneRects(nested, { width: 1400, height: 700 })).toEqual({
      debian: { left: 0, top: 0, width: 50, height: 100 },
      ubuntu: { left: 50, top: 0, width: 25, height: 100 },
      docker: { left: 75, top: 0, width: 25, height: 100 },
    });
  });

  it("collapses a parent split when one pane is removed", () => {
    const vertical = splitTerminalLayout(
      createTerminalLayout("debian"),
      "debian",
      "ubuntu",
      "vertical",
    );
    const nested = splitTerminalLayout(vertical, "ubuntu", "docker", "horizontal");
    const remaining = removeTerminalFromLayout(nested, "ubuntu");

    expect(remaining).not.toBeNull();
    expect(getTerminalPaneRects(remaining!)).toEqual({
      debian: { left: 0, top: 0, width: 50, height: 100 },
      docker: { left: 50, top: 0, width: 50, height: 100 },
    });
  });

  it("keeps the pane tree when selecting a visible terminal tab", () => {
    const layout = splitTerminalLayout(
      createTerminalLayout("debian"),
      "debian",
      "ubuntu",
      "vertical",
    );
    expect(selectTerminalTab(layout, "ubuntu")).toBe(layout);
  });

  it("starts a new tree when selecting a terminal outside the layout", () => {
    const layout = splitTerminalLayout(
      createTerminalLayout("debian"),
      "debian",
      "ubuntu",
      "vertical",
    );
    expect(selectTerminalTab(layout, "alpine")).toEqual(createTerminalLayout("alpine"));
  });
});
