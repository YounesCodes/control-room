export class TerminalProcessing {
  private busy = false;
  private prompt: string | null = null;
  private editing = false;
  private inputLine = "";
  private lineEdited = false;
  private escape = "";
  private pasted = false;
  private typeahead = false;
  private marked = false;
  private program = false;
  private agent = false;
  private agentBusy = false;
  private progressBusy: boolean | null = null;

  constructor(
    private readonly changed: (busy: boolean) => void,
    private readonly returnedToPrompt: () => void = () => undefined,
    private readonly submitted: (command: string) => void = () => undefined,
  ) {}

  reset() {
    this.prompt = null;
    this.editing = false;
    this.inputLine = "";
    this.lineEdited = false;
    this.escape = "";
    this.pasted = false;
    this.typeahead = false;
    this.marked = false;
    this.program = false;
    this.agent = false;
    this.agentBusy = false;
    this.progressBusy = null;
    this.setBusy(false);
  }

  input(bytes: Uint8Array, prompt: string | null, alternate = false) {
    for (const character of new TextDecoder().decode(bytes)) {
      const byte = character.codePointAt(0)!;
      if (
        !this.busy &&
        !this.program &&
        !this.editing &&
        !this.pasted &&
        !this.typeahead &&
        byte !== 3
      ) {
        this.prompt = prompt;
        this.editing = prompt !== null && prompt.trim() !== "";
        this.inputLine = "";
        this.lineEdited = false;
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
          if (this.escape !== "\x1b[200~" && this.escape !== "\x1b[201~") this.lineEdited = true;
          this.escape = "";
        }
        continue;
      }
      if (byte === 0x1b) {
        this.escape = "\x1b";
        continue;
      }
      if (!this.pasted && (byte === 13 || byte === 10)) {
        const renderedInput =
          prompt !== null && this.prompt !== null
            ? prompt.startsWith(this.prompt)
              ? prompt.slice(this.prompt.length)
              : prompt.trimEnd() === this.prompt.trimEnd()
                ? ""
                : prompt
            : "";
        const atShellPrompt = !this.busy && !this.program && !alternate && !!this.prompt?.trim();
        const command = atShellPrompt ? this.visibleCommand(prompt, renderedInput) : null;
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
        this.lineEdited = false;
        this.typeahead = false;
        if (!this.busy) this.editing = false;
        if (command) this.submitted(command);
      } else if (byte === 3 && !this.busy) {
        this.editing = false;
        this.typeahead = false;
        this.inputLine = "";
      } else if (byte === 9) {
        this.lineEdited = true;
      } else if (byte === 21) {
        this.inputLine = "";
      } else if (byte === 8 || byte === 127) {
        this.inputLine = this.inputLine.replace(/.$/u, "");
      } else if (byte >= 32) {
        if (!this.busy && !this.program && !this.editing) this.typeahead = true;
        this.inputLine += character;
      }
    }
  }

  private visibleCommand(row: string | null, rendered: string): string | null {
    const typed = this.inputLine.trim();
    if (typed && !this.lineEdited && row?.includes(typed.slice(-16))) return typed;
    if (row === null || this.prompt === null || !row.startsWith(this.prompt)) return null;
    return rendered.trim() || null;
  }

  output(
    prompt: string | null,
    alternate = false,
    status: readonly string[] | (() => readonly string[]) = [],
  ) {
    if (!alternate && samePrompt(this.prompt ?? "", prompt ?? "")) {
      this.returnedToPrompt();
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
      const activity = agentActivity(typeof status === "function" ? status() : status);
      if (activity !== null) this.agentBusy = activity;
      this.setBusy(this.agentBusy);
      return;
    }
    if (alternate) {
      this.program = true;
      this.stop();
      return;
    }
    this.program = false;
  }

  // OSC 133 and OSC 633 markers: A prompt start, C command execution, D completion.
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

  // OSC 9 also carries notifications; only 9;4 is progress.
  progress(data: string): boolean {
    const match = /^4;([0-4])(?:;(\d{1,3}))?$/.exec(data);
    if (!match || (match[2] !== undefined && Number(match[2]) > 100)) return false;
    // Shells can clear progress at startup before any program runs.
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

function isAgentCommand(command: string): boolean {
  return /^(?:(?:&|call|exec|npx|bunx|uvx)\s+)?["']?(?:[^\s"']*[/\\])?(?:agy|antigravity|codex|claude|pi|opencode|gemini|aider|goose|qwen|amp|droid|kimi|copilot)(?:\.(?:bat|cmd|exe|ps1))?["']?(?:\s|$)/i.test(
    command,
  );
}

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
  return null;
}

function samePrompt(previous: string, current: string): boolean {
  if (!previous.trim()) return false;
  if (previous === current) return true;
  if (/^PS .*> $/.test(previous)) return /^PS .*> $/.test(current);
  if (/^[A-Za-z]:\\.*>$/.test(previous)) return /^[A-Za-z]:\\.*>$/.test(current);
  const bash = previous.match(/^([^\s:]+@[^\s:]+:).*[#$] $/);
  return !!bash && current.startsWith(bash[1]) && /[#$] $/.test(current);
}
