import { expect, it, vi } from "vitest";
import { safeTerminalActivity, TerminalTitle, workspaceActivityLabel } from "./terminal-title";
import { createLocalWorkspace, createRemoteWorkspace } from "./workspace-target";
import { connection } from "../test/app-fixtures";

it.each([
  ["npm run dev --token secret", "npm"],
  ['& "C:\\Program Files\\Python\\python.exe" private.py', "python"],
  ["工具 --password secret", "工具"],
  ["ssh private-host", "ssh"],
  ["htop", "htop"],
  ["vim private.txt", "vim"],
  ["user@host: /private/path", null],
  ["C:\\private\\project", null],
  ["/private/project", null],
  ["PowerShell 7", null],
  ["Administrator: Windows PowerShell", null],
  ["\x1b[31mnpm", null],
  ["npm\nsecret", null],
  ["npm\u202esecret", null],
  ["x".repeat(100), null],
  ["x".repeat(5000), null],
])("reduces untrusted metadata %j to a safe executable", (raw, safe) => {
  expect(safeTerminalActivity(raw!)).toBe(safe);
});

it("changes only on title transitions and clears completed and replaced sessions", () => {
  const changed = vi.fn();
  const title = new TerminalTitle(changed);
  title.report("npm run dev --secret abc");
  title.report("npm run other --secret xyz");
  expect(changed.mock.calls).toEqual([["npm"]]);
  title.marker("D;0");
  title.report("npm old idle title");
  expect(changed.mock.calls).toEqual([["npm"], [null]]);
  title.marker("C");
  title.report("python script.py");
  expect(changed).toHaveBeenLastCalledWith("python");
  title.marker("A");
  expect(changed).toHaveBeenLastCalledWith(null);
  title.reset();
  title.report("htop");
  title.reset();
  expect(changed).toHaveBeenLastCalledWith(null);
});

it("keeps shell identity and duplicate numbering, with manual names taking precedence", () => {
  const local = {
    ...createLocalWorkspace({
      id: "pwsh",
      label: "PowerShell",
      kind: "powershell-7",
      elevated: false,
    }),
    state: "connected" as const,
  };
  const second = { ...local, id: "second" };
  const remote = { ...createRemoteWorkspace(connection()), state: "connected" as const };
  const all = [local, second, remote];
  expect(workspaceActivityLabel(local, all, "npm")).toBe("npm · PowerShell");
  expect(workspaceActivityLabel(second, all, "python")).toBe("python · PowerShell 2");
  expect(workspaceActivityLabel(remote, all, "htop")).toBe("htop · Fixture Alpha");
  expect(workspaceActivityLabel({ ...local, label: "Build" }, all, "npm")).toBe("Build");
  expect(workspaceActivityLabel({ ...local, label: " " }, all, "npm")).toBe("npm · PowerShell");
  expect(workspaceActivityLabel(local, all, "npm", false)).toBe("PowerShell");
  expect(workspaceActivityLabel(local, all, null)).toBe("PowerShell");
  for (const state of ["connecting", "disconnected", "error"] as const)
    expect(workspaceActivityLabel({ ...local, state }, all, "npm")).toBe("PowerShell");
  expect(local.label).toBeNull();
});
