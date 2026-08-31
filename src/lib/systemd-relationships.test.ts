import { describe, expect, it } from "vitest";
import type { SystemdRelationships } from "../types";
import {
  cyclicSystemdUnits,
  relationshipExplanation,
  relationshipsForRoot,
} from "./systemd-relationships";

function fixture(): SystemdRelationships {
  return {
    root: "web.service",
    nodes: [
      {
        id: "web.service",
        unitType: "service",
        description: "Web",
        loadState: "loaded",
        activeState: "active",
        subState: "running",
      },
      {
        id: "network.target",
        unitType: "target",
        description: "Network",
        loadState: "loaded",
        activeState: "active",
        subState: "active",
      },
    ],
    edges: [
      {
        source: "web.service",
        target: "network.target",
        relationship: "after",
      },
      {
        source: "network.target",
        target: "web.service",
        relationship: "requires",
      },
      {
        source: "web.service",
        target: "network.target",
        relationship: "requires",
      },
    ],
    depthLimit: 1,
    nodeLimit: 40,
    edgeLimit: 240,
    truncated: false,
  };
}

describe("systemd relationships", () => {
  it("preserves relationship type and direction around the root", () => {
    const groups = relationshipsForRoot(fixture());
    expect(groups.outgoing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relationship: "after", target: "network.target" }),
        expect.objectContaining({ relationship: "requires", target: "network.target" }),
      ]),
    );
    expect(groups.incoming).toEqual([
      expect.objectContaining({ relationship: "requires", source: "network.target" }),
    ]);
    expect(relationshipExplanation("after")).toMatch(/ordering only/i);
    expect(relationshipExplanation("requires")).toMatch(/does not define startup order/i);
  });

  it("identifies cycles without claiming that they caused a failure", () => {
    expect([...cyclicSystemdUnits(fixture())].sort()).toEqual(["network.target", "web.service"]);
  });

  it("does not turn inverse ordering or symmetric conflict facts into cycles", () => {
    const result = fixture();
    result.edges = [
      { source: "web.service", target: "network.target", relationship: "after" },
      { source: "network.target", target: "web.service", relationship: "before" },
      { source: "web.service", target: "network.target", relationship: "conflicts" },
      { source: "network.target", target: "web.service", relationship: "conflicts" },
    ];
    expect([...cyclicSystemdUnits(result)]).toEqual([]);
  });

  it("preserves explicit truncation metadata", () => {
    expect({ ...fixture(), truncated: true }).toMatchObject({
      depthLimit: 1,
      nodeLimit: 40,
      edgeLimit: 240,
      truncated: true,
    });
  });
});
