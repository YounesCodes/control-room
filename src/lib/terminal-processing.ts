/** Runtime-only command activity. No input or output is saved.
 *
 * Shell markers are authoritative where a shell integration emits them. Every
 * other shell falls back to its rendered prompt, because nothing outside the
 * shell can tell an ordinary command apart from a program's own prompt.
 *
 * A program that waits on the user must never read as a command that is still
 * running: the ring is for a shell doing work, not for a coding agent sitting
 * idle at its composer. The terminal says when a program owns the screen,
 * which covers every such program rather than a list of known agents:
 *
 * An alternate screen belongs to the program drawing on it, such as Vim, less,
 * or an agent with its own frame. Whatever it redraws is not shell activity,
 * and it stays idle until the shell reports work through a marker or takes the
 * screen back. The main screen stays the shell's, where its prompt is what
 * reports completion after a command.
 *
 * A program that draws on the main screen cannot be told apart from a command
 * that prints nothing while it runs, so neither is guessed at: the shell's
 * prompt returning reports completion either way. */
export class TerminalProcessing {
  private busy = false;
  /** The last shell prompt rendered where input was typed. */
  private prompt: string | null = null;
  private editing = false;
  private inputLine = "";
  private escape = "";
  private pasted = false;
  private marked = false;
  /** An alternate screen is in use, so only the shell can resume the ring. */
  private alternate = false;
  /** A program owns the screen, so its prompt is not the shell's. */
  private program = false;

  constructor(private readonly changed: (busy: boolean) => void) {}

  reset() {
    this.prompt = null;
    this.editing = false;
    this.inputLine = "";
    this.escape = "";
    this.pasted = false;
    this.marked = false;
    this.alternate = false;
    this.program = false;
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
        if (
          !this.marked &&
          !this.program &&
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
  output(prompt: string | null, alternate = false) {
    this.alternate = alternate;
    if (alternate) {
      // The program owns this screen, so nothing it draws is shell activity.
      this.program = true;
      this.stop();
      return;
    }
    this.program = false;
    if (this.marked || !this.busy) return;
    if (prompt === null) return;
    // The shell draws its prompt again under the command's transcript, which
    // leaves the transcript's last line above it rather than on the cursor.
    if (samePrompt(this.prompt ?? prompt, prompt)) {
      this.editing = false;
      this.inputLine = "";
      this.setBusy(false);
    }
  }

  /** The terminal left an alternate screen, so the shell has its screen back.
   *  A shell that returned to its prompt is between commands. */
  screen() {
    if (!this.alternate) return;
    this.alternate = false;
    this.program = false;
    this.stop();
  }

  /** OSC 133 and VS Code's OSC 633 use A for prompt start, C for command
   *  execution and D for completion. Do not depend on optional History capture. */
  shellMarker(data: string) {
    const marker = data.split(";", 1)[0];
    if (marker !== "A" && marker !== "C" && marker !== "D") return;
    this.marked = true;
    this.program = false;
    if (marker !== "C") {
      this.editing = false;
      this.inputLine = "";
    }
    this.setBusy(marker === "C");
  }

  command(busy: boolean) {
    this.marked = true;
    this.program = false;
    if (!busy) {
      this.editing = false;
      this.inputLine = "";
    }
    this.setBusy(busy);
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
