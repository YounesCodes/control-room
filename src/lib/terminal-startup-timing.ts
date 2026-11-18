export const TERMINAL_PROMPT_QUIET_MS = 300;

export const TERMINAL_STARTUP_STAGES = [
  "layout",
  "started",
  "firstOutput",
  "firstRender",
  "prompt",
] as const;

export type TerminalStartupStage = (typeof TERMINAL_STARTUP_STAGES)[number];

export type TerminalPromptSource = "marker" | "quiet";

export interface TerminalStartupReport {
  target: string;
  requestedAt: number;
  stages: Partial<Record<TerminalStartupStage, number>>;
  prompt: TerminalPromptSource;
}

export interface TerminalStartupClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number | undefined): void;
}

const browserClock: TerminalStartupClock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (id) => window.clearTimeout(id),
};

const STAGE_LOG_KEYS: Record<TerminalStartupStage, string> = {
  layout: "layout_ms",
  started: "started_ms",
  firstOutput: "first_output_ms",
  firstRender: "first_render_ms",
  prompt: "prompt_ms",
};

const PROMPT_START_MARKER = /^A(;|$)/;

export function isPromptStartMarker(data: string): boolean {
  return PROMPT_START_MARKER.test(data);
}

export function formatTerminalStartup(report: TerminalStartupReport): string {
  const stages = TERMINAL_STARTUP_STAGES.map(
    (stage) => `${STAGE_LOG_KEYS[stage]}=${report.stages[stage] ?? "none"}`,
  );
  return `[control-room] terminal_startup target=${report.target} ${stages.join(" ")} prompt=${report.prompt}`;
}

export class TerminalStartupTiming {
  private readonly requestedAt: number;
  private readonly stages: Partial<Record<TerminalStartupStage, number>> = {};
  private quietTimer: number | undefined;
  private finished = false;

  constructor(
    private readonly target: string,
    private readonly report: (report: TerminalStartupReport) => void,
    private readonly clock: TerminalStartupClock = browserClock,
  ) {
    this.requestedAt = clock.now();
  }

  mark(stage: Exclude<TerminalStartupStage, "prompt" | "firstRender">) {
    this.record(stage, this.clock.now());
  }

  rendered(cursorLine: string | null) {
    if (this.finished) return;
    const at = this.clock.now();
    this.record("firstRender", at);
    this.clock.clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
    if (!cursorLine?.trim()) return;
    this.quietTimer = this.clock.setTimeout(
      () => this.promptAt("quiet", at),
      TERMINAL_PROMPT_QUIET_MS,
    );
  }

  shellMarker(data: string) {
    if (this.finished || this.stages.firstOutput === undefined) return;
    if (isPromptStartMarker(data)) this.promptAt("marker", this.clock.now());
  }

  cancel() {
    this.finished = true;
    this.clock.clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
  }

  private record(stage: TerminalStartupStage, at: number) {
    if (this.finished || this.stages[stage] !== undefined) return;
    this.stages[stage] = Math.round(at - this.requestedAt);
  }

  private promptAt(source: TerminalPromptSource, at: number) {
    if (this.finished) return;
    this.record("prompt", at);
    this.cancel();
    this.report({
      target: this.target,
      requestedAt: this.requestedAt,
      stages: { ...this.stages },
      prompt: source,
    });
  }
}
