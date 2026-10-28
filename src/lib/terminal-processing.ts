/** Runtime-only activity. Shell commands follow markers or their returning
 * prompt. Interactive programs report progress through OSC 9;4, with a
 * rendered-status fallback for coding agents. No input or output is saved. */
export class TerminalProcessing {
  private busy = false;
  /** The last shell prompt rendered where input was typed. */
  private prompt: string | null = null;
  private editing = false;
  private inputLine = "";
  private escape = "";
  private pasted = false;
  private marked = false;
  /** A program owns the screen, so its prompt is not the shell's. */
  private program = false;
  private agent = false;
  private agentBusy = false;
  private progressBusy: boolean | null = null;

  constructor(private readonly changed: (busy: boolean) => void) {}

  reset() {
    this.prompt = null;
    this.editing = false;
    this.inputLine = "";
    this.escape = "";
    this.pasted = false;
    this.marked = false;
    this.program = false;
    this.agent = false;
    this.agentBusy = false;
    this.progressBusy = null;
    this.setBusy(false);
  }

  /** `prompt` is the line the cursor rests on before the input is delivered. */
  input(bytes: Uint8Array, prompt: string | null, alternate = false) {
    // A program's own prompt is not the shell's, so typing into it never reads
    // as a command. Only the shell's prompt can start a command.
    for (const character of new TextDecoder().decode(bytes)) {
      const byte = character.codePointAt(0)!;
      // History, completion, and cursor keys can edit the line before any
      // printable input arrives. Keep the original prompt before that edit.
      if (!this.busy && !this.program && !this.editing && !this.pasted && byte !== 3) {
        this.prompt = prompt;
        this.editing = prompt !== null && prompt.trim() !== "";
        this.inputLine = "";
      }
      if (this.escape) {
        this.escape += character;
        if (this.escape === "\x1b[200~") this.pasted = true;
        if (this.escape === "\x1b[201~") this.pasted = false;
        if (
          this.escape.length > 32 ||
          (this.escape.length > 2 && byte >= 0x40 && byte <= 0x7e) ||
          (this.escape.length === 2 && byte !== 0x5b)
        ) {
          this.escape = "";
        }
        continue;
      }
      if (byte === 0x1b) {
        this.escape = "\x1b";
        continue;
      }
      if (!this.pasted && (byte === 13 || byte === 10)) {
        // A newline can submit an empty line. Only infer activity when the
        // input or the rendered shell-edited line contains something to run.
        // Marked shells and full-screen programs report their own activity.
        const renderedInput =
          prompt !== null && this.prompt !== null
            ? prompt.startsWith(this.prompt)
              ? prompt.slice(this.prompt.length)
              : prompt.trimEnd() === this.prompt.trimEnd()
                ? ""
                : prompt
            : "";
        const launchingAgent =
          !this.program && isAgentCommand(this.inputLine.trim() || renderedInput.trim());
        if (launchingAgent) {
          this.agent = true;
          this.agentBusy = false;
          this.program = true;
        }
        if (
          !this.marked &&
          (!this.program || launchingAgent) &&
          !alternate &&
          this.prompt?.trim() &&
          (this.inputLine.trim() || renderedInput.trim())
        ) {
          this.setBusy(true);
        }
        this.inputLine = "";
        if (!this.busy) this.editing = false;
      } else if (byte === 3 && !this.busy) {
        this.editing = false;
        this.inputLine = "";
      } else if (byte === 21) {
        this.inputLine = "";
      } else if (byte === 8 || byte === 127) {
        this.inputLine = this.inputLine.replace(/.$/u, "");
      } else if (byte >= 32) {
        this.inputLine += character;
      }
    }
  }

  /** The rendered screen after output. `prompt` is the line the cursor rests
   *  on, or null when the cursor is not on a readable line. */
  output(prompt: string | null, alternate = false, status: readonly string[] = []) {
    // A returning shell prompt also clears progress left behind by a killed
    // program. Do not require a clean program exit to recover the indicator.
    if (!alternate && samePrompt(this.prompt ?? "", prompt ?? "")) {
      this.agent = false;
      this.program = false;
      this.progressBusy = null;
      if (!this.marked) this.stop();
      return;
    }
    if (this.progressBusy !== null) {
      this.program = true;
      this.setBusy(this.progressBusy);
      return;
    }
    if (this.agent) {
      this.program = true;
      this.editing = false;
      this.inputLine = "";
      const activity = agentActivity(status);
      if (activity !== null) this.agentBusy = activity;
      this.setBusy(this.agentBusy);
      return;
    }
    if (alternate) {
      // The program owns this screen, so nothing it draws is shell activity.
      this.program = true;
      this.stop();
      return;
    }
    this.program = false;
  }

  /** OSC 133 and VS Code's OSC 633 use A for prompt start, C for command
   *  execution and D for completion. Do not depend on optional History capture. */
  shellMarker(data: string) {
    const marker = data.split(";", 1)[0];
    if (marker !== "A" && marker !== "C" && marker !== "D") return;
    this.marked = true;
    if (marker !== "C") {
      this.program = false;
      this.agent = false;
      this.progressBusy = null;
      this.editing = false;
      this.inputLine = "";
    }
    this.setBusy(marker === "C");
  }

  command(busy: boolean) {
    this.marked = true;
    if (!busy) {
      this.program = false;
      this.agent = false;
      this.progressBusy = null;
      this.editing = false;
      this.inputLine = "";
    }
    this.setBusy(busy);
  }

  /** OSC 9 has other uses, including notifications. Consume only progress.
   * Running and indeterminate spin; clear, failure and pause do not. */
  progress(data: string): boolean {
    const match = /^4;([0-4])(?:;(\d{1,3}))?$/.exec(data);
    if (!match || (match[2] !== undefined && Number(match[2]) > 100)) return false;
    // Shell startup can clear a terminal's progress before any program runs.
    // That is not evidence that an interactive program owns the input.
    if (match[1] === "0" && this.progressBusy === null && !this.program) {
      this.setBusy(false);
      return true;
    }
    this.progressBusy = match[1] === "1" || match[1] === "3";
    this.program = true;
    this.editing = false;
    this.inputLine = "";
    this.setBusy(this.progressBusy);
    return true;
  }

  /** Waiting on the user is not work, so the ring stops with the command. */
  private stop() {
    this.editing = false;
    this.inputLine = "";
    this.setBusy(false);
  }

  private setBusy(busy: boolean) {
    if (this.busy === busy) return;
    this.busy = busy;
    this.changed(busy);
  }
}

/** Only the executable at a command boundary identifies a coding agent.
 * Arguments mentioning an agent, such as `echo codex`, must stay shell work.
 * Unknown tools can use OSC 9;4 without being added here. */
function isAgentCommand(command: string): boolean {
  return /^(?:(?:&|call|exec|npx|bunx|uvx)\s+)?["']?(?:[^\s"']*[/\\])?(?:agy|antigravity|codex|claude|pi|opencode|gemini|aider|goose|qwen|amp|droid|kimi|copilot)(?:\.(?:bat|cmd|exe|ps1))?["']?(?:\s|$)/i.test(
    command,
  );
}

/** Read current UI status, never output frequency. These hints disappear on
 * completion even when the agent keeps its composer open on the main screen. */
function agentActivity(lines: readonly string[]): boolean | null {
  if (
    lines.some((line) =>
      /\b(?:waiting for (?:your|user|approval|permission)|do you want to (?:allow|proceed)|allow (?:once|always))\b/i.test(
        line,
      ),
    )
  ) {
    return false;
  }
  if (
    lines.some(
      (line) =>
        /\besc(?:ape)?\s+(?:to\s+)?(?:interrupt|cancel|stop)\b/i.test(line) &&
        !/\b(?:enter to|to submit|shortcuts|for help|clear\/exit|to clear|to exit|to cycle)\b/i.test(
          line,
        ),
    )
  )
    return true;
  if (lines.some((line) => /\?\s+for shortcuts\b|\benter to (?:send|submit)\b/i.test(line)))
    return false;
  // Agents can erase and repaint their footer in separate output messages.
  // A missing status line is an incomplete frame, not command completion.
  return null;
}

function samePrompt(previous: string, current: string): boolean {
  if (!previous.trim()) return false;
  if (previous === current) return true;
  // Directory changes must not leave an ordinary Bash, PowerShell or cmd
  // session spinning forever. Match the shell's prompt, never a quiet timer.
  if (/^PS .*> $/.test(previous)) return /^PS .*> $/.test(current);
  if (/^[A-Za-z]:\\.*>$/.test(previous)) return /^[A-Za-z]:\\.*>$/.test(current);
  const bash = previous.match(/^([^\s:]+@[^\s:]+:).*[#$] $/);
  return !!bash && current.startsWith(bash[1]) && /[#$] $/.test(current);
}
