/** Runtime-only command activity. No input or output is saved. Shell markers
 * are authoritative; ordinary shells fall back to their rendered prompt. */
export class TerminalProcessing {
  private busy = false;
  private prompt: string | null = null;
  private editing = false;
  private escape = "";
  private pasted = false;
  private marked = false;

  constructor(private readonly changed: (busy: boolean) => void) {}

  reset() {
    this.prompt = null;
    this.editing = false;
    this.escape = "";
    this.pasted = false;
    this.marked = false;
    this.setBusy(false);
  }

  input(bytes: Uint8Array, prompt: string | null) {
    for (const byte of bytes) {
      // History, completion, and cursor keys can edit the line before any
      // printable input arrives. Keep the original prompt before that edit.
      if (!this.busy && !this.editing && !this.pasted && byte !== 3 && prompt?.trim()) {
        this.prompt = prompt;
        this.editing = true;
      }
      if (this.escape) {
        this.escape += String.fromCharCode(byte);
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
        if (this.marked || this.prompt?.trim()) this.setBusy(true);
      } else if (byte === 3 && !this.busy) {
        this.editing = false;
      }
    }
  }

  output(prompt: string | null) {
    if (this.marked || !this.busy || prompt === null || this.prompt === null) return;
    if (samePrompt(this.prompt, prompt)) {
      this.editing = false;
      this.setBusy(false);
    }
  }

  /** OSC 133 and VS Code's OSC 633 use A for prompt start, C for command
   * execution and D for completion. Do not depend on optional History capture. */
  shellMarker(data: string) {
    const marker = data.split(";", 1)[0];
    if (marker !== "A" && marker !== "C" && marker !== "D") return;
    this.marked = true;
    if (marker !== "C") this.editing = false;
    this.setBusy(marker === "C");
  }

  command(busy: boolean) {
    this.marked = true;
    if (!busy) this.editing = false;
    this.setBusy(busy);
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
