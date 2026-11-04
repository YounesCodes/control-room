import { describe, expect, it } from "vitest";
import {
  layoutSystemdGraph,
  SYSTEMD_NODE_WIDTH,
  SYSTEMD_NODE_HEIGHT,
} from "./systemd-graph-layout";
import { systemdEdges } from "./systemd-units";
import { systemdInspection } from "../test/systemd-fixtures";

describe("focused Systemd graph", () => {
  it("ends each line at its arrow base with the tip clear of the destination card", () => {
    const layout = layoutSystemdGraph(
      ["a.service", "b.service"],
      systemdEdges([
        systemdInspection("a.service", { Requires: "b.service", RequiredBy: "b.service" }),
      ]),
      "a.service",
    );
    for (const edge of layout.connections) {
      const end = edge.path.match(/(-?[\d.]+),(-?[\d.]+)$/)!;
      const arrow = edge.arrowhead.match(/M(-?[\d.]+),(-?[\d.]+) L(-?[\d.]+),/)!;
      expect(Number(end[1])).toBe(Number(arrow[3]));
      expect(Number(end[2])).toBe(Number(arrow[2]));
      expect(Math.abs(Number(arrow[1]) - Number(end[1]))).toBe(8);
      const card = layout.positions.get(edge.target)!;
      expect(
        Math.min(
          Math.abs(Number(arrow[1]) - card.x),
          Math.abs(Number(arrow[1]) - card.x - card.width),
        ),
      ).toBe(4);
    }
  });
  it("consolidates one direction without hiding a reverse requirement", () => {
    const edges = systemdEdges([
      systemdInspection("a.service", {
        Requires: "b.service",
        Wants: "b.service",
        RequiredBy: "b.service",
      }),
    ]);
    const layout = layoutSystemdGraph(["a.service", "b.service"], edges, "a.service");
    expect(layout.connections).toHaveLength(2);
    const forward = layout.connections.find((edge) => edge.source === "a.service")!;
    expect(forward.label).toBe("Requires · Wants");
    expect(forward.edges).toHaveLength(2);
    expect(layout.connections.find((edge) => edge.source === "b.service")?.target).toBe(
      "a.service",
    );
    expect(layout.connections[0].path).not.toBe(layout.connections[1].path);
  });

  it("draws After and its reverse Before as one ordering constraint, keeping the original evidence", () => {
    const edges = systemdEdges([
      systemdInspection("a.service", { After: "b.service" }),
      systemdInspection("b.service", { Before: "a.service" }),
    ]);
    const layout = layoutSystemdGraph(["a.service", "b.service"], edges, "a.service");
    expect(layout.connections).toHaveLength(1);
    expect(layout.connections[0]).toMatchObject({
      source: "b.service",
      target: "a.service",
      label: "Before",
      kind: "ordering",
      edges,
    });
    expect(layout.positions.get("b.service")!.x).toBeLessThan(layout.positions.get("a.service")!.x);
  });

  it("preserves existing relative positions while expanding, with consistent node sizes", () => {
    const edges = systemdEdges([
      systemdInspection("a.service", { Requires: "b.service c.service" }),
      systemdInspection("b.service", { Wants: "d.service" }),
    ]);
    const first = layoutSystemdGraph(["a.service", "b.service", "c.service"], edges, "a.service");
    const next = layoutSystemdGraph(
      ["a.service", "b.service", "c.service", "d.service"],
      edges,
      "a.service",
      first.placements,
    );
    for (const id of first.placements.keys())
      expect(next.placements.get(id)).toEqual(first.placements.get(id));
    for (const node of next.positions.values())
      expect([node.width, node.height]).toEqual([SYSTEMD_NODE_WIDTH, SYSTEMD_NODE_HEIGHT]);
    expect(next.connections.flatMap((edge) => edge.edges)).toHaveLength(edges.length);
  });

  it("keeps cycles out of the same column and gives identical evidence a deterministic layout", () => {
    const edges = systemdEdges([
      systemdInspection("a.service", { Requires: "b.service c.service" }),
      systemdInspection("b.service", { Wants: "c.service a.service" }),
    ]);
    const ids = ["a.service", "b.service", "c.service"];
    const first = layoutSystemdGraph(ids, edges, ids[0]);
    const second = layoutSystemdGraph([...ids].reverse(), [...edges].reverse(), ids[0]);
    for (const id of ids) expect(second.positions.get(id)).toEqual(first.positions.get(id));
    for (const edge of first.connections)
      expect(first.positions.get(edge.source)!.x).not.toBe(first.positions.get(edge.target)!.x);
  });
});
