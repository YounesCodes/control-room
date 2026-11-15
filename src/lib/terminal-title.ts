import type { Workspace } from "../types";
import { workspaceDisplayLabel } from "./workspace-lifecycle";

/** Prefixes that run the next word as the actual program. */
const WRAPPERS = /^(?:&|call|exec|command|builtin|nohup|time|sudo|doas|env)$/i;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = /^(?:cmd|powershell|pwsh|bash|zsh|fish|sh|dash|ksh)$/i;

/** Reduce a submitted command line to its program name. Arguments, paths and
 * terminal control sequences never become UI state or saved workspace
 * metadata. Starting another shell shows the shell's own identity. */
export function safeTerminalActivity(value: string): string | null {
  if (value.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const tokens = /\s*(?:"([^"]*)"|'([^']*)'|(\S+))/uy;
  let wrapper: string | null = null;
  for (let index = 0; index < 8; index++) {
    const match = tokens.exec(value);
    if (!match) return wrapper;
    const token = match[1] ?? match[2] ?? match[3];
    if (match[3] !== undefined && ASSIGNMENT.test(token)) continue;
    // `sudo -u root htop` and friends: options make the next word ambiguous.
    if (wrapper && token.startsWith("-")) return wrapper;
    const name = programName(token);
    if (!name) return null;
    if (WRAPPERS.test(name)) {
      wrapper = name === "&" ? wrapper : name;
      continue;
    }
    return SHELLS.test(name) ? null : name;
  }
  return null;
}

function programName(token: string): string | null {
  if (token === "&") return token;
  const executable = token.split(/[/\\]/).at(-1)!;
  const name = executable.replace(/\.(exe|com|cmd|bat|ps1)$/i, "");
  return /^[\p{L}\p{N}_][\p{L}\p{N}_.+-]{0,39}$/u.test(name) ? name : null;
}

export function workspaceActivityLabel(
  workspace: Workspace,
  workspaces: Workspace[],
  activity: string | null | undefined,
  enabled = true,
): string {
  const identity = workspaceDisplayLabel(workspace, workspaces);
  if (!enabled || workspace.label?.trim() || workspace.state !== "connected" || !activity)
    return identity;
  return `${activity} · ${identity}`;
}

/** How long a command must run before its name replaces the shell's. Quick
 * commands such as `cd` or `ls` never flash in the tab. */
export const TERMINAL_TITLE_DELAY_MS = 400;

/** The program running in a terminal, from the command line submitted at the
 * shell prompt or reported by shell integration. Program-set window titles
 * (OSC 0/2) are not used: they name documents, not programs, and a local
 * `ssh` or `wsl` host process reports its own title before the remote shell
 * starts. Per-session runtime metadata, never saved. */
export class TerminalTitle {
  private value: string | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly changed: (title: string | null) => void,
    private readonly delay = TERMINAL_TITLE_DELAY_MS,
  ) {}

  /** A command line was submitted at the shell prompt. */
  command(line: string) {
    const name = safeTerminalActivity(line);
    this.cancel();
    if (!name) return this.set(null);
    if (name === this.value) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.set(name);
    }, this.delay);
  }

  /** OSC 133 and VS Code's OSC 633: A starts a prompt, D completes a command,
   * and 633;E reports the command line about to run. */
  marker(data: string) {
    const [marker, commandLine] = data.split(";", 2);
    if (marker === "A" || marker === "D") this.idle();
    if (marker === "E" && commandLine !== undefined) this.command(decodeOsc633(commandLine));
  }

  /** The shell is back at its prompt. */
  idle() {
    this.cancel();
    this.set(null);
  }

  reset() {
    this.idle();
  }

  private cancel() {
    if (this.pending === null) return;
    clearTimeout(this.pending);
    this.pending = null;
  }

  private set(value: string | null) {
    if (value === this.value) return;
    this.value = value;
    this.changed(value);
  }
}

/** VS Code escapes `\` as `\\` and other bytes, including `;`, as `\xAB`. */
function decodeOsc633(value: string): string {
  return value.replace(/\\(?:\\|x([0-9a-fA-F]{2}))/g, (escape, hex: string | undefined) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : "\\",
  );
}
