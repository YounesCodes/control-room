import { connectionTarget } from "./format";
import type { ConnectionGroup, SavedConnection } from "../types";

export interface ConnectionSection {
  id: string | null;
  name: string;
  collapsed: boolean;
  connections: SavedConnection[];
}

function connectionSort(left: SavedConnection, right: SavedConnection): number {
  return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" });
}

export function connectionMatchesFilter(
  connection: SavedConnection,
  groupName: string | null,
  query: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [
    connection.displayName,
    connectionTarget(connection),
    groupName ?? "Ungrouped",
    ...connection.tags.map((tag) => tag.name),
  ].some((value) => value.toLocaleLowerCase().includes(normalized));
}

export function organizeConnections(
  connections: SavedConnection[],
  groups: ConnectionGroup[],
  query: string,
  ungroupedCollapsed: boolean,
): ConnectionSection[] {
  const orderedGroups = [...groups].sort(
    (left, right) =>
      left.position - right.position ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  const knownGroups = new Set(orderedGroups.map((group) => group.id));
  const sections: ConnectionSection[] = orderedGroups.map((group) => ({
    id: group.id,
    name: group.name,
    collapsed: group.collapsed,
    connections: connections
      .filter(
        (connection) =>
          connection.groupId === group.id && connectionMatchesFilter(connection, group.name, query),
      )
      .sort(connectionSort),
  }));
  sections.push({
    id: null,
    name: "Ungrouped",
    collapsed: ungroupedCollapsed,
    connections: connections
      .filter(
        (connection) =>
          (!connection.groupId || !knownGroups.has(connection.groupId)) &&
          connectionMatchesFilter(connection, null, query),
      )
      .sort(connectionSort),
  });
  return sections;
}
