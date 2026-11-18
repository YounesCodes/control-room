import "./isolation";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { addConnection, ipc, openLocal, terminalCommand } from "./helpers";
import {
  TERMINAL_STARTUP_STAGES,
  type TerminalStartupReport,
} from "../src/lib/terminal-startup-timing";
import type { LocalShellCatalog } from "../src/types";

const RUNS_PER_TARGET = Number(process.env.CONTROL_ROOM_STARTUP_RUNS ?? 3);

interface StartupSample {
  case: string;
  run: number;
  clickToRequestMs: number;
  shellChoiceMs: number | null;
  report: TerminalStartupReport;
}

const samples: StartupSample[] = [];

async function recordClicks() {
  await browser.execute(() => {
    const state = globalThis as unknown as { __startupClicks?: number[] };
    state.__startupClicks = [];
    document.addEventListener("click", () => state.__startupClicks!.push(performance.now()), {
      capture: true,
    });
  });
}

async function nextReport(previous: string | null): Promise<TerminalStartupReport> {
  const pane = $(".terminal-workspace-pane.active .terminal-container");
  let raw: string | null = null;
  await browser.waitUntil(
    async () => {
      raw = await pane.getAttribute("data-terminal-startup-timing");
      return raw !== null && raw !== previous;
    },
    { timeout: 60_000, timeoutMsg: "The terminal never reported a usable prompt" },
  );
  const report = JSON.parse(raw!) as TerminalStartupReport;
  const recorded = TERMINAL_STARTUP_STAGES.map((stage) => report.stages[stage]);
  expect(recorded.every((value) => typeof value === "number")).toBe(true);
  expect([...recorded].sort((a, b) => a! - b!)).toEqual(recorded);
  return report;
}

async function sample(name: string, run: number, open: () => Promise<number | null>) {
  const previous = await $(".terminal-workspace-pane.active .terminal-container")
    .getAttribute("data-terminal-startup-timing")
    .catch(() => null);
  const shellChoiceMs = await open();
  const report = await nextReport(previous);
  const firstClick = await browser.execute(
    () => (globalThis as unknown as { __startupClicks: number[] }).__startupClicks.at(-1) ?? 0,
  );
  const entry = {
    case: name,
    run,
    clickToRequestMs: Math.round(report.requestedAt - firstClick),
    shellChoiceMs,
    report,
  };
  samples.push(entry);
  console.log(`[startup-timing] ${JSON.stringify(entry)}`);
}

function writeSamples() {
  const directory = resolve("test-results/startup-timing");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, `${process.platform}-${Date.now()}.json`),
    JSON.stringify(samples, null, 2),
  );
}

describe("terminal startup timing", () => {
  after(writeSamples);

  it("reports every startup stage for each installed local shell", async function () {
    this.timeout(300_000);
    const { profiles } = await ipc<LocalShellCatalog>("list_local_shells");
    await recordClicks();
    for (const shell of profiles.filter((profile) => !profile.elevated)) {
      const label = shell.label;
      for (let run = 1; run <= RUNS_PER_TARGET; run++) {
        await sample(`local:${shell.id}`, run, async () => {
          await openLocal(label);
          return null;
        });
      }
    }
  });

  for (const target of startupHosts()) {
    it(`reports the startup stages of first and repeated connections to ${target.name}`, async function () {
      this.timeout(300_000);
      await connectRepeatedly(target);
    });
  }
});

interface StartupHost {
  name: string;
  user: string;
  host: string;
  port: string;
}

function startupHosts(): StartupHost[] {
  return (process.env.CONTROL_ROOM_STARTUP_HOSTS ?? "")
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const match = /^([\w-]+)=([^@]+)@([^:]+)(?::(\d+))?$/.exec(entry.trim());
      if (!match) throw new Error(`Expected name=user@host[:port], got ${entry}`);
      return { name: match[1], user: match[2], host: match[3], port: match[4] ?? "22" };
    });
}

async function connectRepeatedly({ name, user, host, port }: StartupHost) {
  const saved = await addConnection("Timing host", host, user, port);
  await ipc("set_connection_history_enabled", { connectionId: saved.id, enabled: false });
  await recordClicks();
  for (let run = 1; run <= RUNS_PER_TARGET + 1; run++) {
    await sample(`ssh:${name}:${run === 1 ? "first" : "repeat"}`, run, async () => {
      const panes = await $$(".terminal-workspace-pane").length;
      if (run === 1) await $(".host-main*=Timing host").click();
      else {
        await $('button[aria-label="New terminal"]').click();
        await $(".new-terminal-menu").$("button*=Timing host").click();
      }
      const started = Date.now();
      const choice = $(".modal input[name='remote-shell']:checked");
      await browser.waitUntil(
        async () =>
          (await choice.isExisting()) ||
          ((await $$(".terminal-workspace-pane").length) > panes &&
            !(await $(".modal").isExisting())),
        { timeout: 60_000, timeoutMsg: "The host connection never reached a terminal" },
      );
      if (!(await choice.isExisting())) return null;
      const shellChoiceMs = Date.now() - started;
      await $(".modal .primary-button").click();
      return shellChoiceMs;
    });
    await terminalCommand("echo TIMING_READY", "TIMING_READY");
  }
}
