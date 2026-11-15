import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  safeTerminalActivity,
  TERMINAL_TITLE_DELAY_MS,
  TerminalTitle,
  workspaceActivityLabel,
} from "./terminal-title";
import { createLocalWorkspace, createRemoteWorkspace } from "./workspace-target";
import { connection } from "../test/app-fixtures";

it.each([
  ["npm run dev --token secret", "npm"],
  ['& "C:\\Program Files\\Python\\python.exe" private.py', "python"],
  ["工具 --password secret", "工具"],
  ["ssh private-host", "ssh"],
  ["htop", "htop"],
  ["  vim private.txt", "vim"],
  ["claude", "claude"],
  ["codex.cmd --yolo", "codex"],
  ["npx.cmd vite", "npx"],
  ["/usr/bin/htop -d 5", "htop"],
  ["./build.sh --release", "build.sh"],
  [".\\deploy.ps1 -Force", "deploy"],
  ["C:\\private\\tool.exe", "tool"],
  ["NODE_ENV=production TOKEN=secret npm start", "npm"],
  ["sudo htop", "htop"],
  ["sudo -u root htop", "sudo"],
  ["time nohup make all", "make"],
  ["exec vim", "vim"],
  ["sudo", "sudo"],
  ["pwsh -NoLogo", null],
  ["bash", null],
  ["cmd /c dir", null],
  ["user@host: /private/path", null],
  ["$env:TOKEN='x'", null],
  ["", null],
  ["\x1b[31mnpm", null],
  ["npm\nsecret", null],
  ["npm\u202esecret", null],
  ["x".repeat(100), null],
  ["x".repeat(5000), null],
])("reduces the command line %j to a safe program name", (raw, safe) => {
  expect(safeTerminalActivity(raw!)).toBe(safe);
});

describe("TerminalTitle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("names a command only once it has run past the delay", () => {
    const changed = vi.fn();
    const title = new TerminalTitle(changed);
    title.command("cd /private/path");
    vi.advanceTimersByTime(TERMINAL_TITLE_DELAY_MS - 1);
    title.idle();
    vi.runAllTimers();
    expect(changed).not.toHaveBeenCalled();
    title.command("npm run dev --secret abc");
    vi.advanceTimersByTime(TERMINAL_TITLE_DELAY_MS);
    expect(changed.mock.calls).toEqual([["npm"]]);
    title.command("npm run other --secret xyz");
    vi.runAllTimers();
    expect(changed.mock.calls).toEqual([["npm"]]);
  });

  it("returns to the shell at prompt markers, completion and reset", () => {
    const changed = vi.fn();
    const title = new TerminalTitle(changed);
    for (const end of [() => title.marker("D;0"), () => title.marker("A"), () => title.reset()]) {
      title.command("python script.py");
      vi.runAllTimers();
      expect(changed).toHaveBeenLastCalledWith("python");
      end();
      expect(changed).toHaveBeenLastCalledWith(null);
    }
    title.marker("C");
    vi.runAllTimers();
    expect(changed).toHaveBeenLastCalledWith(null);
  });

  it("reads VS Code command line reports and ignores other markers", () => {
    const changed = vi.fn();
    const title = new TerminalTitle(changed);
    title.marker("E;git commit -m a\\x3bb;nonce");
    vi.runAllTimers();
    expect(changed).toHaveBeenLastCalledWith("git");
    title.marker("E;C:\\\\tools\\\\htop.exe");
    vi.runAllTimers();
    expect(changed).toHaveBeenLastCalledWith("htop");
    title.marker("P;Cwd=/private");
    title.marker("B");
    vi.runAllTimers();
    expect(changed).toHaveBeenLastCalledWith("htop");
    title.marker("E;bash");
    expect(changed).toHaveBeenLastCalledWith(null);
  });
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
