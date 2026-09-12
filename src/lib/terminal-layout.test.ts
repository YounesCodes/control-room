import { describe, expect, it } from "vitest";
import {
  createTerminalLayout,
  getTerminalLayoutIds,
  getTerminalPaneRects,
  getResponsiveTerminalPaneRects,
  removeTerminalFromLayout,
  selectTerminalTab,
  splitTerminalLayout,
} from "./terminal-layout";

describe("terminal pane tree", () => {
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
