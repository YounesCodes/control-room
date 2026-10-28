import { describe, expect, it, vi } from "vitest";
import { TerminalProcessing } from "./terminal-processing";

const bytes = (value: string) => new TextEncoder().encode(value);

const prompt = "dev@host:~$ ";
/** The line the shell leaves the cursor on while its transcript is above. */
const busyLine = "";
/** The prompt the shell draws again under the command's transcript. */
const returnedLine = prompt;

describe("terminal command processing", () => {
  it.each(["", " ", "    ", "\t"])("stays idle when submitting blank input %j", (input) => {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.input(bytes(input), prompt);
    tracker.input(bytes("\r"), `${prompt}${input}`);
    tracker.output(prompt);
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
    tracker.output(busyLine);
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

  it("stays busy while the shell is not back at its prompt", () => {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.input(bytes("sleep 60"), prompt);
    expect(changed).not.toHaveBeenCalled();
    tracker.input(bytes("\r"), prompt);
    expect(changed.mock.calls).toEqual([[true]]);
    tracker.output(busyLine);
    tracker.output(busyLine);
    expect(changed.mock.calls).toEqual([[true]]);
    tracker.output(returnedLine);
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
    tracker.input(bytes("sleep 60\r"), prompt);
    tracker.input(bytes("\x03"), "");
    expect(changed.mock.calls).toEqual([[true]]);
    tracker.output(returnedLine);
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

describe("terminal processing with an interactive program", () => {
  /** Starts an agent from the prompt and lets it take the alternate screen,
   *  the way a coding agent draws its own composer. */
  function launchAgent() {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.input(bytes("agent\r"), prompt);
    tracker.output("Welcome", true);
    return { changed, tracker };
  }

  it("stops spinning as soon as the agent takes the screen", () => {
    const { changed } = launchAgent();
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });

  it("stays idle while an idle agent redraws its composer", () => {
    const { changed, tracker } = launchAgent();
    for (let frame = 0; frame < 20; frame++) {
      tracker.input(bytes("x"), "> ", true);
      tracker.output("> build the app", true);
    }
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });

  it("only spins when the agent reports its own work through a marker", () => {
    const { changed, tracker } = launchAgent();
    tracker.input(bytes("build the app\r"), "> ", true);
    tracker.output("> ", true);
    expect(changed.mock.calls).toEqual([[true], [false]]);
    tracker.shellMarker("C");
    expect(changed.mock.calls).toEqual([[true], [false], [true]]);
    tracker.shellMarker("D;0");
    expect(changed.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it("returns idle once the agent exits and the shell prompt comes back", () => {
    const { changed, tracker } = launchAgent();
    tracker.screen();
    tracker.output(prompt);
    expect(changed.mock.calls).toEqual([[true], [false]]);
    tracker.input(bytes("ls\r"), prompt);
    expect(changed.mock.calls).toEqual([[true], [false], [true]]);
    tracker.output(busyLine);
    tracker.output(prompt);
    expect(changed.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it("never spins for an agent whose screen hides the prompt", () => {
    // An agent that clears the prompt leaves nothing for the shell to return
    // to, so waiting on a prompt would spin forever.
    const { changed, tracker } = launchAgent();
    for (let frame = 0; frame < 5; frame++) tracker.output("composer", true);
    tracker.screen();
    tracker.output(prompt);
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });

  it("does not read typing into an agent as a shell command", () => {
    const { changed, tracker } = launchAgent();
    tracker.input(bytes("build the app\r"), "> ", true);
    tracker.output("> ", true);
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });

  it("stops when the program takes the screen", () => {
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.input(bytes("agent\r"), prompt);
    tracker.output("> ", true);
    expect(changed.mock.calls).toEqual([[true], [false]]);
    tracker.output("> ", true);
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });

  it("keeps an ordinary full-screen program silent until it exits", () => {
    // Vim and less were already silent while running; they stay silent.
    const changed = vi.fn();
    const tracker = new TerminalProcessing(changed);
    tracker.input(bytes("vim\r"), prompt);
    tracker.output("~", true);
    tracker.output("~", true);
    tracker.screen();
    tracker.output(prompt);
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });
});
