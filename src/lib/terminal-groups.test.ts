import { describe, expect, it } from "vitest";
import { createTerminalLayout, getTerminalLayoutIds, splitTerminalLayout } from "./terminal-layout";
import {
  nextTerminalGroupName,
  pruneTerminalGroups,
  terminalGroupForWorkspace,
  type TerminalGroup,
} from "./terminal-groups";

function group(id: string, name: string, first: string, second?: string): TerminalGroup {
  return {
    id,
    name,
    layout: second
      ? splitTerminalLayout(createTerminalLayout(first), first, second, "vertical")
      : createTerminalLayout(first),
  };
}

describe("terminal groups", () => {
  it("numbers groups instead of naming them after a member terminal", () => {
    expect(nextTerminalGroupName([])).toBe("Group 1");
    expect(nextTerminalGroupName([group("a", "Group 1", "one")])).toBe("Group 2");
    expect(nextTerminalGroupName([group("a", "group 2", "one")])).toBe("Group 1");
    expect(nextTerminalGroupName([group("a", "Group 1", "one"), group("b", "Builds", "two")])).toBe(
      "Group 2",
    );
  });

  it("keeps the first group when malformed state repeats a Workspace", () => {
    const result = pruneTerminalGroups(
      [group("a", "First", "one", "two"), group("b", "Second", "two", "three")],
      new Set(["one", "two", "three"]),
    );
    expect(result.map((item) => [item.name, ...getTerminalLayoutIds(item.layout)])).toEqual([
      ["First", "one", "two"],
    ]);
    expect(terminalGroupForWorkspace(result, "two")?.id).toBe("a");
    expect(terminalGroupForWorkspace(result, "three")).toBeNull();
  });

  it("drops groups that have fewer than two open terminals", () => {
    expect(pruneTerminalGroups([group("a", "Solo", "one")], new Set(["one"]))).toEqual([]);
  });
});
