import { describe, expect, it } from "vitest";
import type { SystemdUnit } from "../types";
import {
  countSystemdUnits,
  filterSystemdUnits,
  isSystemdUnitName,
  systemdEdges,
  systemdNeighborhood,
  systemdValue,
  SYSTEMD_RELATIONSHIPS,
  navigateSystemdExplorer,
} from "./systemd-units";
import { systemdInspection } from "../test/systemd-fixtures";

function unit(
  id: string,
  unitType: string,
  activeState: string,
  subState = activeState,
): SystemdUnit {
  return {
    id,
    unitType,
    description: `${id} description`,
    loadState: "loaded",
    activeState,
    subState,
    unitFileState: "enabled",
  };
}

describe("Systemd unit filtering", () => {
  const fixtures = [
    unit("web.service", "service", "active", "running"),
    unit("backup.timer", "timer", "failed"),
    unit("data.mount", "mount", "failed"),
    unit("api.socket", "socket", "active", "listening"),
    unit("old.service", "service", "inactive", "dead"),
  ];

  it("counts active and failed units across types", () => {
    expect(countSystemdUnits(fixtures)).toEqual({ active: 2, failed: 2, inactive: 1, other: 0 });
    expect(countSystemdUnits([])).toEqual({ active: 0, failed: 0, inactive: 0, other: 0 });
  });

  it("sorts failures first and then uses stable type and identity ordering", () => {
    const result = filterSystemdUnits(fixtures, {
      search: "",
      state: "all",
      unitType: "all",
    });
    expect(result.map((item) => item.id)).toEqual([
      "data.mount",
      "backup.timer",
      "old.service",
      "web.service",
      "api.socket",
    ]);
  });

  it("filters by state, type, identity, and description", () => {
    expect(
      filterSystemdUnits(fixtures, { search: "", state: "failed", unitType: "timer" }).map(
        (item) => item.id,
      ),
    ).toEqual(["backup.timer"]);
    expect(
      filterSystemdUnits(fixtures, { search: "data.mount", state: "all", unitType: "all" }).map(
        (item) => item.id,
      ),
    ).toEqual(["data.mount"]);
    expect(
      filterSystemdUnits(fixtures, { search: "socket description", state: "all", unitType: "all" }),
    ).toHaveLength(1);
  });
});

describe("Systemd dependency evidence", () => {
  it("retains a returning selection but refocuses a different unit from another inspector", () => {
    const state = {
      mode: "graph",
      rootId: "a.service",
      expanded: ["b.service"],
      search: "a",
      dependencySearch: "b",
      state: "failed",
      unitType: "service",
      sort: "priority",
      relationships: ["Requires"],
    } as const;
    const current = {
      ...state,
      expanded: [...state.expanded],
      relationships: [...state.relationships],
    };
    expect(navigateSystemdExplorer(current, "b.service", "b.service")).toBe(current);
    expect(navigateSystemdExplorer(current, "b.service", "c.timer")).toEqual({
      ...current,
      rootId: "c.timer",
      expanded: [],
      search: "",
      dependencySearch: "",
      state: "all",
      unitType: "all",
    });
  });
  it("keeps requirement and ordering evidence separate, with correct reverse directions", () => {
    const edges = systemdEdges([
      systemdInspection("a.service", {
        Requires: "b.service",
        After: "b.service",
        WantedBy: "c.target",
        Before: "d.target",
        Triggers: "worker.service",
      }),
      systemdInspection("b.service", { RequiredBy: "a.service" }),
    ]);
    expect(edges.map(({ source, relationship, target }) => [source, relationship, target])).toEqual(
      [
        ["a.service", "Requires", "b.service"],
        ["c.target", "Wants", "a.service"],
        ["a.service", "After", "b.service"],
        ["a.service", "Before", "d.target"],
        ["a.service", "Triggers", "worker.service"],
      ],
    );
    expect(systemdEdges([systemdInspection("backup.timer", { Unit: "backup.service" })])).toEqual(
      [],
    );
  });
  it("never expands a neighbor until requested, bounds cycles and exposes hidden nodes", () => {
    const edges = systemdEdges([
      systemdInspection("a.service", { Requires: "b.service" }),
      systemdInspection("b.service", { Wants: "c.service a.service" }),
    ]);
    expect(systemdNeighborhood("a.service", [], edges, [...SYSTEMD_RELATIONSHIPS]).ids).toEqual([
      "a.service",
      "b.service",
    ]);
    expect(
      systemdNeighborhood("a.service", ["b.service"], edges, [...SYSTEMD_RELATIONSHIPS]).ids,
    ).toEqual(["a.service", "b.service", "c.service"]);
    expect(systemdNeighborhood("a.service", ["b.service"], edges, ["Requires"]).ids).toEqual([
      "a.service",
      "b.service",
    ]);
    expect(
      systemdNeighborhood("a.service", ["b.service"], edges, [...SYSTEMD_RELATIONSHIPS], "c").ids,
    ).toEqual(["a.service", "b.service", "c.service"]);
    expect(
      systemdNeighborhood("a.service", ["b.service"], edges, [...SYSTEMD_RELATIONSHIPS], "", 2)
        .hidden,
    ).toBe(1);
  });
  it("rejects invalid evidence and preserves escaped names", () => {
    expect(isSystemdUnitName(String.raw`srv-data\x2darchive.mount`)).toBe(true);
    expect(isSystemdUnitName(String.raw`broken\xZZ.mount`)).toBe(false);
    expect(
      systemdEdges([
        systemdInspection("a.service", {
          Requires: "a.service bad;unit.service *.service good.service",
        }),
      ]).map((edge) => edge.target),
    ).toEqual(["good.service"]);
    expect(systemdValue("0")).toBe("0");
    expect(systemdValue("18446744073709551615")).toBe("Unavailable");
  });

  it("keeps different relationships distinct when unit names contain colons", () => {
    const edges = systemdEdges([
      systemdInspection("a.service", { Requires: "b.service:Requires:c.service" }),
      systemdInspection("a.service:Requires:b.service", { Requires: "c.service" }),
    ]);
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(2);
  });
  it("never treats inactive, disabled, or transitioning units as failed", () => {
    const units = [
      { ...unit("idle.service", "service", "inactive"), unitFileState: "disabled" },
      unit("starting.service", "service", "activating"),
    ];
    expect(countSystemdUnits(units)).toEqual({ active: 0, failed: 0, inactive: 1, other: 1 });
    expect(
      filterSystemdUnits(units, {
        search: "disabled",
        state: "all",
        unitType: "all",
        sort: "name",
      }).map((item) => item.id),
    ).toEqual(["idle.service"]);
    expect(
      filterSystemdUnits(
        [unit("web.service", "service", "active"), unit("api.socket", "socket", "active")],
        { search: "", state: "all", unitType: "all", sort: "name" },
      )[0].id,
    ).toBe("api.socket");
  });
});
