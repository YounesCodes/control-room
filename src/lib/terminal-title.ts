import type { Workspace } from "../types";
import { workspaceDisplayLabel } from "./workspace-lifecycle";

const WRAPPERS = /^(?:&|call|exec|command|builtin|nohup|time|sudo|doas|env)$/i;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = /^(?:cmd|powershell|pwsh|bash|zsh|fish|sh|dash|ksh)$/i;

export function safeTerminalActivity(value: string): string | null {
  if (value.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const tokens = /\s*(?:"([^"]*)"|'([^']*)'|(\S+))/uy;
  let wrapper: string | null = null;
  for (let index = 0; index < 8; index++) {
    const match = tokens.exec(value);
    if (!match) return wrapper;
    const token = match[1] ?? match[2] ?? match[3];
    if (match[3] !== undefined && ASSIGNMENT.test(token)) continue;
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

export const TERMINAL_TITLE_DELAY_MS = 400;

// OSC 0/2 titles are ignored: a local ssh or wsl process sets its own before the remote shell starts.
export class TerminalTitle {
  private value: string | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly changed: (title: string | null) => void,
    private readonly delay = TERMINAL_TITLE_DELAY_MS,
  ) {}

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

  // OSC 133 and OSC 633: A starts a prompt, D completes a command, 633;E reports the command line.
  marker(data: string) {
    const [marker, commandLine] = data.split(";", 2);
    if (marker === "A" || marker === "D") this.idle();
    if (marker === "E" && commandLine !== undefined) this.command(decodeOsc633(commandLine));
  }

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

// VS Code escapes `\` as `\\` and other bytes, including `;`, as `\xAB`.
function decodeOsc633(value: string): string {
  return value.replace(/\\(?:\\|x([0-9a-fA-F]{2}))/g, (escape, hex: string | undefined) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : "\\",
  );
}
