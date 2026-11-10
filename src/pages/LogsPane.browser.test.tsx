import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { settings, connection } from "../test/app-fixtures";
import type { SystemdUnit } from "../types";
import "../styles.css";

const native = vi.hoisted(() => ({ output: null as ((message: ArrayBuffer) => void) | null }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    set onmessage(handler: (message: ArrayBuffer) => void) {
      native.output = handler;
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));
vi.mock("../lib/api", () => ({
  api: {
    startJournalStream: async () => ({ streamId: "stream-a" }),
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
      servicesCache={{ items: [unit], fetchedAt: Date.now(), loading: false, error: null }}
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
  const results = await axe.run(container!);
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});
