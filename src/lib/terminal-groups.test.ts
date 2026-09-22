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
  it("names groups without using their terminal count", () => {
    expect(nextTerminalGroupName([])).toBe("Terminal group");
    expect(nextTerminalGroupName([group("a", "Terminal group", "one")])).toBe("Terminal group 2");
    expect(nextTerminalGroupName([], "Git Bash")).toBe("Git Bash group");
    expect(nextTerminalGroupName([group("a", "Git Bash group", "one")], "Git Bash")).toBe(
      "Git Bash group 2",
    );
    expect(nextTerminalGroupName([], "a".repeat(80))).toHaveLength(80);
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
