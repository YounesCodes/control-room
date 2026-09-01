import { describe, expect, it } from "vitest";
import type { ConnectionGroup, SavedConnection } from "../types";
import { connectionMatchesFilter, organizeConnections } from "./connection-organization";

function connection(id: string, patch: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id,
    displayName: id,
    destination: `${id}.example`,
    username: "user",
    port: null,
    identityFile: null,
    historyEnabled: false,
    groupId: null,
    tags: [],
    createdAt: "",
    updatedAt: "",
    lastConnectedAt: null,
    ...patch,
  };
}

const groups: ConnectionGroup[] = [
  { id: "group-b", name: "Staging", position: 1, collapsed: true },
  { id: "group-a", name: "Production", position: 0, collapsed: false },
];

describe("connection organization", () => {
  it("groups deterministically by name and retains Ungrouped", () => {
    const sections = organizeConnections(
      [
        connection("worker", { groupId: "group-a" }),
        connection("api", { groupId: "group-a" }),
        connection("orphan", { groupId: "deleted-group" }),
      ],
      groups,
      "",
      false,
    );

    expect(sections.map((section) => section.name)).toEqual(["Production", "Staging", "Ungrouped"]);
    expect(sections[0].connections.map((item) => item.id)).toEqual(["api", "worker"]);
    expect(sections[1].collapsed).toBe(true);
    expect(sections[2].connections[0].id).toBe("orphan");
  });

  it("filters locally across names, targets, groups, and tags", () => {
    const saved = connection("api", {
      groupId: "group-a",
      tags: [{ id: "tag-a", name: "Critical" }],
    });
    expect(connectionMatchesFilter(saved, "Production", "critical")).toBe(true);
    expect(connectionMatchesFilter(saved, "Production", "production")).toBe(true);
    expect(connectionMatchesFilter(saved, "Production", "api.example")).toBe(true);
    expect(connectionMatchesFilter(saved, "Production", "missing")).toBe(false);
  });
});
