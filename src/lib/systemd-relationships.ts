import type {
  SystemdRelationshipEdge,
  SystemdRelationships,
  SystemdRelationshipType,
} from "../types";

const labels: Record<SystemdRelationshipType, string> = {
  requires: "Requires",
  wants: "Wants",
  requisite: "Requisite",
  bindsTo: "Binds to",
  partOf: "Part of",
  conflicts: "Conflicts",
  before: "Before",
  after: "After",
};

const explanations: Record<SystemdRelationshipType, string> = {
  requires: "Activation requirement; this does not define startup order.",
  wants: "Weaker activation request; this does not define startup order.",
  requisite: "Must already be active when this unit starts.",
  bindsTo: "A stronger requirement that couples active lifecycles.",
  partOf: "Stop and restart changes can propagate from the referenced unit.",
  conflicts: "The two units cannot remain active together.",
  before: "Ordering only: the source is ordered before the target.",
  after: "Ordering only: the source is ordered after the target.",
};

export function relationshipLabel(type: SystemdRelationshipType) {
  return labels[type];
}

export function relationshipExplanation(type: SystemdRelationshipType) {
  return explanations[type];
}

export function relationshipsForRoot(result: SystemdRelationships) {
  const compare = (left: SystemdRelationshipEdge, right: SystemdRelationshipEdge) =>
    left.relationship.localeCompare(right.relationship) ||
    left.source.localeCompare(right.source) ||
    left.target.localeCompare(right.target);
  return {
    outgoing: result.edges.filter((edge) => edge.source === result.root).sort(compare),
    incoming: result.edges.filter((edge) => edge.target === result.root).sort(compare),
  };
}

const requirementTypes: SystemdRelationshipType[] = [
  "requires",
  "wants",
  "requisite",
  "bindsTo",
  "partOf",
];

function nodesOnCycle(adjacency: Map<string, string[]>) {
  const cyclic = new Set<string>();
  for (const start of adjacency.keys()) {
    const pending = [...(adjacency.get(start) ?? [])];
    const visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === start) {
        cyclic.add(start);
        break;
      }
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(adjacency.get(current) ?? []));
    }
  }
  return cyclic;
}

export function cyclicSystemdUnits(result: SystemdRelationships) {
  // Requirement edges ("I depend on X") and ordering edges ("start me after X")
  // point in opposite logical directions, and systemd's recommended pattern
  // pairs `Wants=X` with `After=X`. Merging both into one graph would turn that
  // pair into a false two-node cycle, so each family gets its own graph and only
  // genuine cycles are unioned. `conflicts` is not a dependency direction.
  const ordering = new Map<string, string[]>();
  const requirement = new Map<string, string[]>();
  for (const node of result.nodes) {
    ordering.set(node.id, []);
    requirement.set(node.id, []);
  }
  for (const edge of result.edges) {
    if (edge.relationship === "before") {
      ordering.get(edge.source)?.push(edge.target);
    } else if (edge.relationship === "after") {
      ordering.get(edge.target)?.push(edge.source);
    } else if (requirementTypes.includes(edge.relationship)) {
      requirement.get(edge.source)?.push(edge.target);
    }
  }

  const cyclic = new Set<string>();
  for (const node of nodesOnCycle(ordering)) cyclic.add(node);
  for (const node of nodesOnCycle(requirement)) cyclic.add(node);
  return cyclic;
}
