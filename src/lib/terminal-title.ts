import type { Workspace } from "../types";
import { workspaceDisplayLabel } from "./workspace-lifecycle";

/** Only retain the executable name. Arguments, paths, prompts and terminal
 * control sequences never become UI state or saved workspace metadata. */
export function safeTerminalActivity(value: string): string | null {
  if (value.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const match = /^(?:&\s+)?(?:"([^"]+)"|'([^']+)'|([^\s]+))(?:\s|$)/u.exec(value.trim());
  if (!match) return null;
  const executable = (match[1] ?? match[2] ?? match[3]).split(/[/\\]/).at(-1)!;
  const name = executable.replace(/\.(exe|cmd|bat|ps1)$/i, "");
  if (!/^[\p{L}\p{N}_][\p{L}\p{N}_.+-]{0,39}$/u.test(name)) return null;
  if (/^(?:cmd|powershell|pwsh|bash|zsh|fish|sh|administrator|windows)$/i.test(name)) return null;
  // A bare path is usually an idle shell's working directory.
  if (/[/\\]/.test(match[1] ?? match[2] ?? match[3]) && !/\.(exe|cmd|bat|ps1)$/i.test(executable))
    return null;
  return name;
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

/** Per-session metadata, independent of output frequency and busy indicators. */
export class TerminalTitle {
  private value: string | null = null;
  private atPrompt = false;
  constructor(private readonly changed: (title: string | null) => void) {}
  report(value: string) {
    if (!this.atPrompt) this.set(safeTerminalActivity(value));
  }
  marker(data: string) {
    const marker = data.split(";", 1)[0];
    if (marker === "C") this.atPrompt = false;
    if (marker === "A" || marker === "D") this.idle();
  }
  idle() {
    this.atPrompt = true;
    this.set(null);
  }
  reset() {
    this.atPrompt = false;
    this.set(null);
  }
  private set(value: string | null) {
    if (value === this.value) return;
    this.value = value;
    this.changed(value);
  }
}
