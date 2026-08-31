import type { SystemdUnit } from "../types";

export type SystemdStateFilter = "all" | "failed" | "active" | "inactive";

export interface SystemdUnitFilters {
  search: string;
  state: SystemdStateFilter;
  unitType: string;
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
      return counts;
    },
    { active: 0, failed: 0 },
  );
}

export function filterSystemdUnits(units: SystemdUnit[], filters: SystemdUnitFilters) {
  const query = filters.search.trim().toLowerCase();
  return units
    .filter((unit) => {
      if (filters.state !== "all" && unit.activeState !== filters.state) return false;
      if (filters.unitType !== "all" && unit.unitType !== filters.unitType) return false;
      if (!query) return true;
      return [
        unit.id,
        unit.unitType,
        unit.description,
        unit.loadState,
        unit.activeState,
        unit.subState,
      ].some((value) => value.toLowerCase().includes(query));
    })
    .sort(compareUnits);
}
