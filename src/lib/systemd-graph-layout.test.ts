import { describe, expect, it } from "vitest";
import { layoutSystemdGraph } from "./systemd-graph-layout";
import { systemdEdges } from "./systemd-units";
import { systemdInspection } from "../test/systemd-fixtures";

describe("Systemd graph routing", () => {
  it("preserves each reported direction when a pair has parallel and reverse relationships", () => {
    const evidence = systemdEdges([
      systemdInspection("a.service", {
        Requires: "b.service",
        After: "b.service",
        RequiredBy: "b.service",
      }),
    ]);
    const layout = layoutSystemdGraph(["a.service", "b.service"], evidence, "a.service");
    expect(layout.connections).toHaveLength(1);
    expect(layout.connections[0].edges).toEqual(evidence);
    expect(layout.connections[0].arrowLeft).toBe(true);
    expect(layout.connections[0].arrowRight).toBe(true);
    const reverseOnly = layoutSystemdGraph(["a.service", "b.service"], [evidence[1]], "a.service");
    expect(reverseOnly.connections[0].arrowLeft).toBe(true);
    expect(reverseOnly.connections[0].arrowRight).toBe(false);
  });

  it("keeps cycle members in separate columns and reserves space for labels", () => {
    const evidence = systemdEdges([
      systemdInspection("a.service", { Requires: "b.service c.service" }),
      systemdInspection("b.service", { After: "c.service", Wants: "a.service" }),
    ]);
    const layout = layoutSystemdGraph(
      ["a.service", "b.service", "c.service"],
      evidence,
      "a.service",
    );
    expect(new Set([...layout.positions.values()].map((node) => node.x)).size).toBe(3);
    expect(layout.connections.flatMap((connection) => connection.edges)).toHaveLength(
      evidence.length,
    );
    for (const connection of layout.connections) {
      const left = layout.positions.get(connection.left)!;
      const right = layout.positions.get(connection.right)!;
      expect(connection.badge.x).toBeGreaterThan(left.x + left.width);
      expect(connection.badge.x + connection.badge.width).toBeLessThan(right.x);
      expect(connection.badge.height).toBeGreaterThan(connection.edges.length * 20);
    }
  });

  it("balances large neighborhoods without merging distinct unit identities or clipping routes", () => {
    const ids = [
      "a.service",
      ...Array.from({ length: 59 }, (_, index) => "neighbor-" + index + ".target"),
    ];
    const evidence = systemdEdges([
      systemdInspection(ids[0], {
        Requires: ids.slice(1).join(" "),
        After: ids.slice(1).join(" "),
      }),
    ]);
    const layout = layoutSystemdGraph(ids, evidence, ids[0]);
    expect(layout.positions.size).toBe(60);
    expect(layout.connections).toHaveLength(59);
    const columns = new Map<number, number>();
    for (const node of layout.positions.values()) {
      columns.set(node.x, (columns.get(node.x) ?? 0) + 1);
      expect(node.x + node.width).toBeLessThan(layout.width);
      expect(node.y + node.height).toBeLessThan(layout.height);
    }
    expect(Math.max(...columns.values())).toBeLessThanOrEqual(8);
  });
});
