import { describe, expect, it } from "vitest";
import type { SystemdUnit } from "../types";
import { countSystemdUnits, filterSystemdUnits } from "./systemd-units";

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
    expect(countSystemdUnits(fixtures)).toEqual({ active: 2, failed: 2 });
    expect(countSystemdUnits([])).toEqual({ active: 0, failed: 0 });
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
