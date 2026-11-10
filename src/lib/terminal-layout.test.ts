import { describe, expect, it } from "vitest";
import {
  createTerminalLayout,
  getTerminalLayoutIds,
  getTerminalPaneRects,
  getTerminalPanePixels,
  getResponsiveTerminalPaneRects,
  getResponsiveTerminalGeometry,
  resizeTerminalLayout,
  pruneTerminalLayout,
  removeTerminalFromLayout,
  selectTerminalTab,
  splitTerminalLayout,
  swapTerminalLayout,
  dockTerminalLayout,
  orientTerminalLayout,
  terminalParentSplitPath,
  terminalSplitDirection,
  terminalDropZone,
  getTerminalLayoutSurface,
  terminalLayoutFits,
  terminalPaneOuterEdges,
  getTerminalDividerHandles,
  resizeTerminalHandle,
  transposeTerminalCross,
  insertTerminalBeside,
  type TerminalLayout,
} from "./terminal-layout";

describe("terminal pane tree", () => {
  const nested = () =>
    resizeTerminalLayout(
      splitTerminalLayout(
        splitTerminalLayout(createTerminalLayout("a"), "a", "b", "vertical"),
        "b",
        "c",
        "horizontal",
      ),
      "",
      0.6,
    );

  it("swaps nested leaves while keeping geometry, ratios and session membership", () => {
    const layout = nested();
    const swapped = swapTerminalLayout(layout, "a", "c");
    expect(getTerminalLayoutIds(swapped)).toEqual(["c", "b", "a"]);
    expect(getTerminalPaneRects(swapped).c).toEqual(getTerminalPaneRects(layout).a);
    expect(swapped).toMatchObject({
      direction: "vertical",
      ratio: 0.6,
      second: { direction: "horizontal" },
    });
    expect(swapTerminalLayout(swapped, "c", "a")).toEqual(layout);
  });

  it.each(["left", "right", "top", "bottom"] as const)(
    "detaches and docks at the %s edge, collapsing empty ancestors",
    (edge) => {
      const layout = nested();
      const moved = dockTerminalLayout(layout, "a", "c", edge);
      expect(getTerminalLayoutIds(moved).sort()).toEqual(["a", "b", "c"]);
      expect(moved).toMatchObject({
        kind: "split",
        direction: "horizontal",
        first: { workspaceId: "b" },
        second: {
          kind: "split",
          direction: edge === "left" || edge === "right" ? "vertical" : "horizontal",
        },
      });
      const geometry = getTerminalPaneRects(moved);
      if (edge === "left") expect(geometry.a.left + geometry.a.width).toBe(geometry.c.left);
      if (edge === "right") expect(geometry.c.left + geometry.c.width).toBe(geometry.a.left);
      if (edge === "top") expect(geometry.a.top + geometry.a.height).toBe(geometry.c.top);
      if (edge === "bottom") expect(geometry.c.top + geometry.c.height).toBe(geometry.a.top);
      expect(layout).toEqual(nested());
    },
  );

  it("rejects self, missing and duplicate members and avoids orientation churn", () => {
    const layout = nested();
    for (const [source, target] of [
      ["a", "a"],
      ["a", "missing"],
      ["missing", "b"],
    ]) {
      expect(swapTerminalLayout(layout, source, target)).toBe(layout);
      expect(dockTerminalLayout(layout, source, target, "top")).toBe(layout);
    }
    const duplicate = {
      kind: "split",
      direction: "vertical",
      first: layout,
      second: createTerminalLayout("a"),
    } as const;
    expect(swapTerminalLayout(duplicate, "a", "b")).toBe(duplicate);
    expect(dockTerminalLayout(duplicate, "a", "b", "top")).toBe(duplicate);
    expect(getTerminalLayoutIds(pruneTerminalLayout(duplicate, new Set(["a", "b", "c"]))!)).toEqual(
      ["a", "b", "c"],
    );
    expect(pruneTerminalLayout(layout, new Set(["a", "b", "c"]))).toBe(layout);
    expect(orientTerminalLayout(layout, "missing", "horizontal")).toBe(layout);
    expect(orientTerminalLayout(layout, "", "vertical")).toBe(layout);
    expect(orientTerminalLayout(layout, "second", "vertical")).toMatchObject({
      ratio: 0.6,
      second: { direction: "vertical" },
    });
    expect(terminalParentSplitPath(layout, "a")).toBe("");
    expect(terminalParentSplitPath(layout, "c")).toBe("second");
    expect(terminalParentSplitPath(layout, "missing")).toBeNull();
    expect(terminalSplitDirection(layout, "")).toBe("vertical");
    expect(terminalSplitDirection(layout, "second")).toBe("horizontal");
    expect(terminalSplitDirection(layout, "missing")).toBeNull();
  });

  it("distinguishes drop centers, every edge, outside and nonfinite coordinates", () => {
    expect(terminalDropZone(0.5, 0.5)).toBe("center");
    expect(terminalDropZone(0.1, 0.5)).toBe("left");
    expect(terminalDropZone(0.9, 0.5)).toBe("right");
    expect(terminalDropZone(0.5, 0.1)).toBe("top");
    expect(terminalDropZone(0.5, 0.9)).toBe("bottom");
    expect(terminalDropZone(-0.1, 0.5)).toBeNull();
    expect(terminalDropZone(1.1, 0.5)).toBeNull();
    expect(terminalDropZone(NaN, 0.5)).toBeNull();
  });

  it("keeps deeply nested panes usable with a local scrolling fallback and restores saved geometry", () => {
    let layout = nested();
    for (let i = 0; i < 6; i++) layout = splitTerminalLayout(layout, "c", `extra-${i}`, "vertical");
    const original = structuredClone(layout);
    const available = { width: 598, height: 350 };
    const compact = getTerminalLayoutSurface(layout, available);
    expect(terminalLayoutFits(layout, available)).toBe(false);
    for (const rectangle of Object.values(compact.panes)) {
      expect((rectangle.width * compact.viewport.width) / 100).toBeGreaterThanOrEqual(279.99);
      expect((rectangle.height * compact.viewport.height) / 100).toBeGreaterThanOrEqual(179.99);
    }
    expect(layout).toEqual(original);
    const large = getTerminalLayoutSurface(layout, { width: 7000, height: 1400 });
    expect(large.viewport).toEqual({ width: 7000, height: 1400 });
    expect(large.dividers[0].direction).toBe("vertical");
    expect(large.panes.a.width).toBe(60);
  });
  it("rounds shared split edges without gaps at odd viewport sizes", () => {
    const layout = splitTerminalLayout(
      splitTerminalLayout(createTerminalLayout("a"), "a", "b", "vertical"),
      "b",
      "c",
      "horizontal",
    );
    const viewport = { width: 959, height: 563 };
    const rects = getResponsiveTerminalPaneRects(layout, viewport);
    const a = getTerminalPanePixels(rects.a, viewport)!;
    const b = getTerminalPanePixels(rects.b, viewport)!;
    const c = getTerminalPanePixels(rects.c, viewport)!;
    expect(a).toEqual({ left: 0, top: 0, width: 480, height: 563 });
    expect(b).toEqual({ left: 480, top: 0, width: 479, height: 282 });
    expect(c).toEqual({ left: 480, top: 282, width: 479, height: 281 });
    expect(a.left + a.width).toBe(b.left);
    expect(b.top + b.height).toBe(c.top);
    expect(c.top + c.height).toBe(viewport.height);
  });

  it("keeps responsive directions stable when the fallback scrollbar consumes space", () => {
    let layout = createTerminalLayout("a");
    for (const [target, next] of [
      ["a", "b"],
      ["b", "d"],
      ["b", "c"],
      ["d", "e"],
    ]) {
      layout = splitTerminalLayout(layout, target, next, "vertical");
    }
    const available = { width: 560, height: 540 };
    const initial = getTerminalLayoutSurface(layout, available);
    const scrolled = getTerminalLayoutSurface(layout, { width: 549, height: 540 }, available);
    expect(initial.viewport.height).toBeGreaterThan(available.height);
    expect(scrolled.viewport).toEqual({ width: 560, height: initial.viewport.height });
    expect(scrolled.dividers.map(({ direction }) => direction)).toEqual(
      initial.dividers.map(({ direction }) => direction),
    );
  });

  it("keeps percentage layout available until the viewport is measurable", () => {
    const rectangle = { left: 0, top: 0, width: 100, height: 100 };
    expect(getTerminalPanePixels(rectangle, { width: Infinity, height: Infinity })).toBeNull();
    expect(getTerminalPanePixels(rectangle, { width: 0, height: 700 })).toBeNull();
  });

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
    expect(small.panes.local.height).toBeCloseTo((520 / 700) * 100);
    expect(small.panes.ssh.top).toBeCloseTo((520 / 700) * 100);
    expect(small.dividers[0].position).toBeCloseTo(520);
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

  it("names the sides of a pane that meet the window border", () => {
    const layout = splitTerminalLayout(
      splitTerminalLayout(createTerminalLayout("a"), "a", "b", "vertical"),
      "b",
      "c",
      "horizontal",
    );
    const rects = getTerminalPaneRects(layout);
    expect(terminalPaneOuterEdges(rects.a)).toEqual(["left", "bottom"]);
    expect(terminalPaneOuterEdges(rects.b)).toEqual(["right"]);
    expect(terminalPaneOuterEdges(rects.c)).toEqual(["right", "bottom"]);
    expect(terminalPaneOuterEdges({ left: 33.333, top: 0, width: 33.333, height: 50 })).toEqual([]);
  });

  describe("crossed splits", () => {
    // Two columns, each split at the same height: a cross.
    const grid = (): TerminalLayout => {
      let layout = splitTerminalLayout(createTerminalLayout("a"), "a", "c", "vertical");
      layout = splitTerminalLayout(layout, "a", "b", "horizontal");
      return splitTerminalLayout(layout, "c", "d", "horizontal");
    };
    const viewport = { width: 1200, height: 800 };
    const handles = (layout: TerminalLayout) =>
      getTerminalDividerHandles(
        layout,
        getTerminalLayoutSurface(layout, viewport).dividers,
        viewport,
      );

    it("regroups a cross into rows without moving any pane", () => {
      const layout = resizeTerminalLayout(grid(), "", 0.4);
      const rows = transposeTerminalCross(layout, "");
      expect(rows).toMatchObject({ direction: "horizontal", first: { direction: "vertical" } });
      expect(getTerminalPaneRects(rows)).toEqual(getTerminalPaneRects(layout));
      expect(transposeTerminalCross(rows, "")).toEqual(layout);
    });

    it("offers each half of a crossed divider on its own", () => {
      const offered = handles(grid());
      expect(offered.map(({ path, direction, transpose }) => [path, direction, transpose])).toEqual(
        [
          ["first", "vertical", ""],
          ["second", "vertical", ""],
          ["first", "horizontal", null],
          ["second", "horizontal", null],
        ],
      );
      const [top, bottom] = offered;
      expect(top.rectangle).toMatchObject({ top: 0, height: 50 });
      expect(bottom.rectangle).toMatchObject({ top: 50, height: 50 });
    });

    it("resizes only the row whose half is dragged", () => {
      const before = getTerminalPaneRects(grid());
      const [top] = handles(grid());
      const after = getTerminalPaneRects(resizeTerminalHandle(grid(), top, 0.3));
      expect(after.a.width).toBeCloseTo(30);
      expect(after.c.width).toBeCloseTo(70);
      expect(after.b).toEqual(before.b);
      expect(after.d).toEqual(before.d);
    });

    it("keeps a whole divider where the crossing lines do not meet", () => {
      const staggered = resizeTerminalLayout(grid(), "first", 0.3);
      expect(handles(staggered).map(({ path, transpose }) => [path, transpose])).toEqual([
        ["", null],
        ["first", null],
        ["second", null],
      ]);
      const nested = splitTerminalLayout(
        splitTerminalLayout(createTerminalLayout("a"), "a", "b", "vertical"),
        "b",
        "c",
        "horizontal",
      );
      expect(handles(nested).every(({ transpose }) => transpose === null)).toBe(true);
    });
  });

  it("brings an outside terminal in beside a target on the chosen edge", () => {
    const single = createTerminalLayout("a");
    expect(getTerminalPaneRects(insertTerminalBeside(single, "x", "a", "left")).x).toMatchObject({
      left: 0,
      width: 50,
    });
    expect(getTerminalPaneRects(insertTerminalBeside(single, "x", "a", "bottom")).x).toMatchObject({
      top: 50,
      height: 50,
    });
    const pair = splitTerminalLayout(single, "a", "b", "vertical");
    const above = getTerminalPaneRects(insertTerminalBeside(pair, "x", "b", "top"));
    expect(above.x).toEqual({ left: 50, top: 0, width: 50, height: 50 });
    expect(above.b).toEqual({ left: 50, top: 50, width: 50, height: 50 });
    expect(above.a).toEqual({ left: 0, top: 0, width: 50, height: 100 });
    // Already a member, or no such target: nothing to insert.
    expect(insertTerminalBeside(pair, "a", "b", "left")).toBe(pair);
    expect(insertTerminalBeside(pair, "x", "missing", "left")).toBe(pair);
  });
});
