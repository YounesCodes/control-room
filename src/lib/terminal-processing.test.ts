import { describe, expect, it, vi } from "vitest";
import { TerminalProcessing } from "./terminal-processing";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("terminal command processing", () => {
  it.each(["", " ", "    ", "\t"])("stays idle when submitting blank input %j", (input) => {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.input(bytes(input), "dev@host:~$ ");
    tracker.input(bytes("\r"), `dev@host:~$ ${input}`);
    tracker.output("dev@host:~$ ");
    expect(changed).not.toHaveBeenCalled();
  });

  it("stays idle after an edited command is erased, then tracks the next command", () => {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.input(bytes("sleep 60"), "$ ");
    tracker.input(bytes("\x15"), "$ sleep 60");
    tracker.input(bytes("\r"), "$ ");
    tracker.output("$ ");
    expect(changed).not.toHaveBeenCalled();
    tracker.input(bytes("sleep 60\r"), "$ ");
    tracker.output("$ ");
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });

  it.each(["echo", "é", "😀"])("stays idle after backspacing all of %j", (input) => {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.input(bytes(input), "$ ");
    tracker.input(bytes("\x7f".repeat(Array.from(input).length)), `$ ${input}`);
    tracker.input(bytes("\r"), "$ ");
    expect(changed).not.toHaveBeenCalled();
  });

  it("waits for the command-start marker instead of predicting activity on Enter", () => {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.shellMarker("A");
    tracker.input(bytes(" \r"), "$ ");
    tracker.shellMarker("A");
    expect(changed).not.toHaveBeenCalled();
    tracker.input(bytes("sleep 60\r"), "$ ");
    expect(changed).not.toHaveBeenCalled();
    tracker.shellMarker("C");
    tracker.shellMarker("D;0");
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });

  it("returns idle after submitting a command recalled with shell history", () => {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.output("$ ");
    tracker.input(bytes("\x1b[A"), "$ ");
    tracker.input(bytes("\r"), "$ echo hello");
    tracker.output("hello");
    tracker.output("$ ");
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });
  it("does not invent command activity before a shell prompt is available", () => {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.input(bytes("\r"), null);
    expect(changed).not.toHaveBeenCalled();
    tracker.shellMarker("C");
    expect(changed).toHaveBeenCalledWith(true);
  });
  it("stays busy through a silent command and clears only when its prompt returns", () => {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.input(bytes("sleep 60"), "dev@host:~$ ");
    expect(changed).not.toHaveBeenCalled();
    tracker.input(bytes("\r"), "dev@host:~$ sleep 60");
    expect(changed.mock.calls).toEqual([[true]]);
    tracker.output("");
    tracker.output("still working");
    expect(changed.mock.calls).toEqual([[true]]);
    tracker.output("dev@host:~$ ");
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });

  it.each([
    ["dev@host:~$ ", "dev@host:/tmp$ "],
    ["PS C:\\Users\\dev> ", "PS D:\\work> "],
    ["C:\\Users\\dev>", "D:\\work>"],
    ["❯ ", "❯ "],
  ])("recognizes a returned %s prompt after changing directory", (before, after) => {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.input(bytes("cd work\r"), before);
    tracker.output(after);
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });

  it("uses shell markers for silent commands, multiline input and custom prompts", () => {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.shellMarker("A");
    tracker.shellMarker("B");
    tracker.shellMarker("C");
    tracker.output("looks like the old prompt");
    expect(changed.mock.calls).toEqual([[true]]);
    tracker.shellMarker("D;1");
    expect(changed.mock.calls).toEqual([[true], [false]]);
    tracker.shellMarker("C");
    tracker.shellMarker("A");
    expect(changed.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it("does not submit multiline bracketed paste, even when escape sequences are split", () => {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    for (const part of ["\x1b[2", "00~first\rsecond\n", "\x1b[20", "1~"]) {
      tracker.input(bytes(part), "$ ");
    }
    expect(changed).not.toHaveBeenCalled();
    tracker.input(bytes("\r"), "$ firstsecond");
    tracker.output("$ ");
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });

  it("does not stop a command on Ctrl+C until the shell actually returns", () => {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.input(bytes("sleep 60\r"), "$ ");
    tracker.input(bytes("\x03"), "");
    expect(changed.mock.calls).toEqual([[true]]);
    tracker.output("$ ");
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });

  it("clears stale command state and shell markers on disconnect or reconnect", () => {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.command(true);
    tracker.reset();
    tracker.input(bytes("pwd\r"), "$ ");
    tracker.output("$ ");
    expect(changed.mock.calls).toEqual([[true], [false], [true], [false]]);
  });
});
