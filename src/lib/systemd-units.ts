import type { SystemdExplorerState, SystemdInspection, SystemdUnit } from "../types";

export interface SystemdUnitFilters {
  search: string;
  state: string;
  unitType: string;
  sort?: SystemdExplorerState["sort"];
}

function compareText(left: string, right: string) {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareUnits(left: SystemdUnit, right: SystemdUnit) {
  const failure = Number(right.activeState === "failed") - Number(left.activeState === "failed");
  if (failure) return failure;
  const unitType = compareText(left.unitType, right.unitType);
  return unitType || compareText(left.id, right.id);
}

export function countSystemdUnits(units: SystemdUnit[]) {
  return units.reduce(
    (counts, unit) => {
      if (unit.activeState === "active") counts.active += 1;
      if (unit.activeState === "failed") counts.failed += 1;
      if (unit.activeState === "inactive") counts.inactive += 1;
      if (!["active", "failed", "inactive"].includes(unit.activeState)) counts.other += 1;
      return counts;
    },
    { active: 0, failed: 0, inactive: 0, other: 0 },
  );
}

export function filterSystemdUnits(units: SystemdUnit[], filters: SystemdUnitFilters) {
  const query = filters.search.trim().toLowerCase();
  return units
    .filter((unit) => {
      if (filters.state !== "all" && unit.activeState !== filters.state) return false;
      if (filters.unitType !== "all" && unit.unitType !== filters.unitType) return false;
      if (!query) return true;
      const text = [
        unit.id,
        unit.unitType,
        unit.description,
        unit.loadState,
        unit.activeState,
        unit.subState,
        unit.unitFileState ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return query.split(/\s+/).every((token) => text.includes(token));
    })
    .sort((left, right) => {
      if (filters.sort === "name") return compareText(left.id, right.id);
      if (filters.sort === "state")
        return compareText(left.activeState, right.activeState) || compareText(left.id, right.id);
      if (filters.sort === "type")
        return compareText(left.unitType, right.unitType) || compareText(left.id, right.id);
      return compareUnits(left, right);
    });
}

export const SYSTEMD_RELATIONSHIPS = ["Requires", "Wants", "After", "Before", "Triggers"] as const;
export type SystemdRelationship = (typeof SYSTEMD_RELATIONSHIPS)[number];
export interface SystemdEdge {
  id: string;
  source: string;
  target: string;
  relationship: SystemdRelationship;
}

export function systemdEdges(details: SystemdInspection[]): SystemdEdge[] {
  const edges = new Map<string, SystemdEdge>();
  for (const detail of details) {
    for (const [property, relationship, reverse] of [
      ["Requires", "Requires", false],
      ["RequiredBy", "Requires", true],
      ["Wants", "Wants", false],
      ["WantedBy", "Wants", true],
      ["After", "After", false],
      ["Before", "Before", false],
      ["Triggers", "Triggers", false],
      ["TriggeredBy", "Triggers", true],
    ] as const) {
      for (const neighbor of (detail.properties[property] ?? "").split(/\s+/).filter(Boolean)) {
        // Names are validated again before any backend read. Never infer a
        // dependency from matching basenames, timer/service suffixes or PIDs.
        if (!isSystemdUnitName(neighbor) || neighbor === detail.id) continue;
        const source = reverse ? neighbor : detail.id;
        const target = reverse ? detail.id : neighbor;
        const id = `${source}:${relationship}:${target}`;
        edges.set(id, { id, source, target, relationship });
      }
    }
  }
  return [...edges.values()];
}

export function isSystemdUnitName(value: string) {
  return (
    value.length <= 255 &&
    /^(?:[a-zA-Z0-9@_.:-]|\\x[0-9a-fA-F]{2})+\.(?:service|socket|device|mount|automount|swap|target|path|timer|slice|scope)$/.test(
      value,
    )
  );
}

/** A bounded breadth-first neighborhood, expanded only from explicit user choices. */
export function systemdNeighborhood(
  root: string,
  expanded: string[],
  edges: SystemdEdge[],
  relationships: string[],
  search = "",
  limit = 60,
) {
  const allowed = edges.filter((edge) => relationships.includes(edge.relationship));
  const candidates = new Set([root]);
  const reached = new Set([root]);
  const parents = new Map<string, string>();
  const expand = new Set([root, ...expanded]);
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const unit = queue[i];
    if (!expand.has(unit)) continue;
    for (const edge of allowed) {
      const neighbor =
        edge.source === unit ? edge.target : edge.target === unit ? edge.source : null;
      if (!neighbor) continue;
      candidates.add(neighbor);
      if (!reached.has(neighbor)) {
        reached.add(neighbor);
        parents.set(neighbor, unit);
        queue.push(neighbor);
      }
    }
  }
  const query = search.trim().toLowerCase();
  const matches = new Set([root]);
  for (const candidate of candidates) {
    if (!candidate.toLowerCase().includes(query)) continue;
    let current: string | undefined = candidate;
    while (current && !matches.has(current)) {
      matches.add(current);
      current = parents.get(current);
    }
  }
  const matching = [...candidates].filter((id) => matches.has(id));
  const ids = matching.slice(0, limit);
  const visible = new Set(ids);
  return {
    ids,
    edges: allowed.filter((edge) => visible.has(edge.source) && visible.has(edge.target)),
    hidden: matching.length - ids.length,
  };
}

export function systemdValue(value: string | undefined) {
  return !value ||
    ["[not set]", "n/a", "infinity", "18446744073709551615", "18446744073709551"].includes(value)
    ? "Unavailable"
    : value;
}

export function navigateSystemdExplorer(
  state: SystemdExplorerState | undefined,
  previousId: string | null,
  unit: string,
) {
  if (!state || previousId === unit) return state;
  return {
    ...state,
    rootId: unit,
    expanded: [],
    search: "",
    dependencySearch: "",
    state: "all",
    unitType: "all",
  };
}
