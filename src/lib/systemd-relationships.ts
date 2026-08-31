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

export function cyclicSystemdUnits(result: SystemdRelationships) {
  const adjacency = new Map<string, string[]>();
  for (const node of result.nodes) adjacency.set(node.id, []);
  for (const edge of result.edges) {
    if (edge.relationship === "conflicts") continue;
    const [source, target] =
      edge.relationship === "after" ? [edge.target, edge.source] : [edge.source, edge.target];
    adjacency.get(source)?.push(target);
  }

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
