import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { runAxe } from "../test/axe";
import { settings, connection } from "../test/app-fixtures";
import type { StreamStateEvent, SystemdUnit } from "../types";
import type { LogTimeBounds } from "../lib/log-time-range";
import "../styles.css";

const native = vi.hoisted(() => ({
  output: null as ((message: ArrayBuffer) => void) | null,
  streamState: null as ((event: { payload: StreamStateEvent }) => void) | null,
  startJournal: vi.fn(
    async (
      _connectionId: string,
      source: string,
      _lines: number,
      _follow: boolean,
      _password: string | null,
      _output: unknown,
      _bounds: LogTimeBounds | null,
    ) => ({ streamId: `stream-${source}` }),
  ),
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    set onmessage(handler: (message: ArrayBuffer) => void) {
      native.output = handler;
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: typeof native.streamState) => {
    if (event === "stream-state-changed") native.streamState = handler;
    return () => undefined;
  },
}));
vi.mock("../lib/api", () => ({
  api: {
    startJournalStream: native.startJournal,
    stopLogStream: async () => undefined,
    listServices: async () => [],
    listContainers: async () => [],
  },
  errorMessage: String,
}));

import { LogsPane } from "./LogsPane";

const unit: SystemdUnit = {
  id: "worker.service",
  unitType: "service",
  description: "Worker",
  loadState: "loaded",
  activeState: "active",
  subState: "running",
  unitFileState: "enabled",
};
const messages = [
  "batch finished in 1.84s",
  "warning: queue depth 1200 exceeds soft limit 1000",
  "error: job 99172 failed: upstream returned 503",
  "request payload accepted",
];
const journal = (from: number, count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      `2026-11-01T09:58:${String((from + index) % 60).padStart(2, "0")}.104233+00:00 host worker[1]: ${
        messages[(from + index) % messages.length]
      } #${from + index}\n`,
  ).join("");

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  root?.unmount();
  container?.remove();
  native.startJournal.mockClear();
});

async function mount() {
  container = document.createElement("div");
  container.style.cssText = "position:relative;width:1100px;height:720px";
  document.body.append(container);
  root = createRoot(container);
  root.render(
    <LogsPane
      connection={connection()}
      settings={settings}
      logTailOptions={[200]}
      servicesCache={{
        items: [unit, { ...unit, id: "backup.timer", description: "Nightly snapshots" }],
        fetchedAt: Date.now(),
        loading: false,
        error: null,
      }}
      containersCache={{ items: [], fetchedAt: Date.now(), loading: false, error: null }}
      selectedSource={{ type: "systemd", id: unit.id }}
      onServicesCacheChange={() => undefined}
      onContainersCacheChange={() => undefined}
      onSourceChange={() => undefined}
    />,
  );
  await page.getByRole("button", { name: "Start" }).click();
  await expect.element(page.getByText("Streaming")).toBeInTheDocument();
}

it("has no automatically detectable accessibility violations while streaming", async () => {
  await mount();
  native.output?.(new TextEncoder().encode(journal(0, 40)).buffer);
  await expect.element(page.getByText(/#39$/)).toBeInTheDocument();
  await page.getByRole("button", { name: /^Errors/ }).click();
  const results = await runAxe(container!);
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

it("suggests matching sources as you type and commits only the chosen journal", async () => {
  await mount();
  const input = page.getByRole("combobox", { name: "Journal" });
  await input.fill("nightly");
  await expect.element(page.getByRole("option", { name: /backup.timer/ })).toBeVisible();
  await expect
    .element(page.getByRole("option", { name: "worker.service" }))
    .not.toBeInTheDocument();
  expect(native.startJournal.mock.calls.map((call) => call[1])).toEqual(["worker.service"]);

  await input.fill("no matching source");
  await expect.element(page.getByText("No matching log sources.")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(input).toHaveValue("worker.service");
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();

  await input.fill("system journal");
  await expect.element(page.getByRole("option", { name: /Full system journal/ })).toBeVisible();
  const results = await runAxe(container!);
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
  await userEvent.keyboard("{Enter}");
  await expect.element(input).toHaveValue("Full system journal");
  await expect
    .element(page.getByText("[systemd Full system journal] stream started"))
    .toBeVisible();
  expect(native.startJournal.mock.calls.map((call) => call[1])).toEqual(["worker.service", "all"]);
});

it("validates a custom range, reads it from the host and restores follow when cleared", async () => {
  await mount();
  const trigger = page.getByRole("button", { name: "Time range", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Log time range" });
  await dialog.getByRole("button", { name: "Custom", exact: true }).click();
  const from = "2026-11-01T09:30";
  const to = "2026-11-01T10:00";
  await dialog.getByLabelText("From").fill(to);
  await dialog.getByLabelText("To").fill(from);
  await dialog.getByRole("button", { name: "Read logs" }).click();
  await expect.element(dialog.getByRole("alert")).toHaveTextContent("End must be after start.");
  expect(native.startJournal.mock.calls).toHaveLength(1);
  await dialog.getByLabelText("From").fill(from);
  await dialog.getByLabelText("To").fill(to);
  const axe = await runAxe(dialog.element());
  expect(axe.violations.map(({ id }) => id)).toEqual([]);
  await dialog.getByRole("button", { name: "Read logs" }).click();
  await expect.element(page.getByText("Reading entries from worker.service…")).toBeVisible();
  expect(native.startJournal.mock.calls.at(-1)?.[3]).toBe(false);
  expect(native.startJournal.mock.calls.at(-1)?.[6]).toEqual({
    start: new Date(from).getTime() / 1000,
    end: new Date(to).getTime() / 1000,
  });
  native.streamState?.({
    payload: { state: "stopped", streamId: "stream-worker.service", reason: null },
  });
  await expect.element(page.getByText("No entries in this time range.")).toBeVisible();
  const follow = page.getByRole("checkbox", { name: "Receive new lines" });
  await expect.element(follow).toBeDisabled();
  await page.getByRole("button", { name: /Time range.*Custom range/ }).click();
  await dialog.getByRole("button", { name: "Clear range" }).click();
  await expect.element(follow).toBeChecked();
  await expect.element(trigger).toHaveFocus();
});
