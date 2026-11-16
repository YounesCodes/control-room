import type { PersistedTerminalGroup } from "../generated/ipc";
import { getTerminalLayoutIds, pruneTerminalLayout } from "./terminal-layout";

export type TerminalGroup = PersistedTerminalGroup;

export function terminalGroupForWorkspace(
  groups: TerminalGroup[],
  workspaceId: string | null,
): TerminalGroup | null {
  if (!workspaceId) return null;
  return groups.find((group) => getTerminalLayoutIds(group.layout).includes(workspaceId)) ?? null;
}

export function nextTerminalGroupName(groups: TerminalGroup[]): string {
  const names = new Set(groups.map((group) => group.name.trim().toLocaleLowerCase()));
  for (let number = 1; ; number += 1) {
    const name = `Group ${number}`;
    if (!names.has(name.toLocaleLowerCase())) return name;
  }
}

export function pruneTerminalGroups(
  groups: TerminalGroup[] | undefined,
  workspaceIds: Set<string>,
): TerminalGroup[] {
  const claimed = new Set<string>();
  const usedIds = new Set<string>();
  const result: TerminalGroup[] = [];

  for (const [index, group] of (groups ?? []).entries()) {
    const available = new Set([...workspaceIds].filter((id) => !claimed.has(id)));
    const layout = pruneTerminalLayout(group.layout, available);
    if (!layout || getTerminalLayoutIds(layout).length < 2) continue;
    for (const id of getTerminalLayoutIds(layout)) claimed.add(id);

    const baseId = group.id.trim() || `terminal-group-${index + 1}`;
    let id = baseId;
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${baseId}-${suffix}`;
    usedIds.add(id);
    const name = group.name.trim() || nextTerminalGroupName(result);
    result.push({ id, name, layout });
  }
  return result;
}

export function deleteTerminalGroup(groups: TerminalGroup[], groupId: string): TerminalGroup[] {
  return groups.filter((group) => group.id !== groupId);
}

export function renameTerminalGroup(
  groups: TerminalGroup[],
  groupId: string,
  name: string,
): TerminalGroup[] {
  const trimmed = name.replace(/\p{Cc}+/gu, " ").trim();
  if (!trimmed) return groups;
  return groups.map((group) => (group.id === groupId ? { ...group, name: trimmed } : group));
}
