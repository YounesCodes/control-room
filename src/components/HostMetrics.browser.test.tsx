import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HeaderMetrics } from "../types";
import { HostMetrics } from "./HostMetrics";
import "../styles.css";

const reading = vi.hoisted(() => ({
  sample: null as HeaderMetrics | null,
  history: [] as HeaderMetrics[],
  error: null as string | null,
  stale: false,
  sampling: false,
  visible: true,
  refresh: vi.fn(),
}));
vi.mock("../hooks/use-header-metrics", () => ({ useHeaderMetrics: () => reading }));
const sample = (cpu: number): HeaderMetrics => ({
  sampledAt: new Date().toISOString(),
  cpuPercent: cpu,
  memoryTotalKib: 1000,
  memoryAvailableKib: 500,
  gpuPercent: 20,
  diskTotalKib: null,
  diskFreeKib: null,
  diskLabel: null,
  diskReadBytesPerSecond: 512,
  diskWriteBytesPerSecond: 0,
  uptimeSeconds: 30,
});
beforeEach(() => {
  Object.assign(reading, {
    sample: sample(10),
    history: [sample(10)],
    error: null,
    stale: false,
    sampling: false,
    visible: true,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("smooths host percentages, rates, and uptime while keeping evidence exact and resetting for a new host", () => {
  let now = 0,
    id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((key) => {
    frames.delete(key);
  });
  const tick = (ms: number) => {
    now += ms;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(now));
  };
  const pane = (target = "first") => (
    <HostMetrics
      target={target}
      name={target}
      metrics={["cpu", "ram", "gpu", "diskIo", "uptime"]}
      seconds={5}
      onSettings={vi.fn()}
    />
  );
  const view = render(pane());
  const cell = (metric: string) =>
    document.querySelector<HTMLElement>(`[data-metric="${metric}"]`)!;
  const visual = (metric: string) => cell(metric).querySelector<HTMLElement>(".host-metric-value")!;
  expect(visual("cpu").textContent).toBe("10%");
  expect(frames.size).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Live: Host metrics for first" }));
  reading.sample = {
    ...sample(90),
    memoryAvailableKib: 100,
    gpuPercent: 80,
    diskReadBytesPerSecond: 4096,
    diskWriteBytesPerSecond: 2048,
    uptimeSeconds: 50,
  };
  reading.history = [...reading.history, reading.sample];
  view.rerender(pane());
  expect(cell("cpu")).toHaveAccessibleName("CPU: 90%");
  expect(cell("diskIo")).toHaveAccessibleName("Disk I/O: Read 4.0 KiB/s · Write 2.0 KiB/s");
  expect(cell("cpu").title).toContain("90%");
  const path = cell("cpu").querySelector("path")!.getAttribute("d");
  const duration = parseFloat(getComputedStyle(visual("cpu")).getPropertyValue("--motion-slow"));
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    expect(visual("cpu").textContent).toBe("10%");
    tick(duration / 2);
    for (const [metric, min, max] of [
      ["cpu", 10, 90],
      ["ram", 50, 90],
      ["gpu", 20, 80],
      ["uptime", 30, 50],
    ] as const) {
      const value = parseFloat(visual(metric).textContent!);
      expect(value).toBeGreaterThan(min);
      expect(value).toBeLessThan(max);
    }
    expect(visual("diskIo").textContent).not.toContain("4.0 KiB/s");
    expect(
      document.querySelector(".host-metrics-panel .animated-number > [aria-hidden]")!.textContent,
    ).toBe(visual("cpu").textContent);
    expect(cell("cpu").querySelector("path")!.getAttribute("d")).toBe(path);
    expect(reading.history).toHaveLength(2);
    tick(duration / 2);
  }
  expect(visual("cpu").textContent).toBe("90%");
  expect(visual("diskIo").textContent).toBe("R 4.0 KiB/s W 2.0 KiB/s");
  expect(visual("uptime").textContent).toBe("50s");
  expect(frames.size).toBe(0);
  expect(
    visual("cpu").querySelector(".animated-number > span")!.hasAttribute("data-tauri-drag-region"),
  ).toBe(true);
  reading.sample = { ...sample(70), gpuPercent: null, diskReadBytesPerSecond: null };
  reading.error = "Offline";
  view.rerender(pane());
  expect(visual("cpu").textContent).toBe("70%");
  expect(visual("gpu").textContent).toBe("—");
  expect(visual("diskIo").textContent).toBe("—");
  expect(frames.size).toBe(0);
  reading.error = null;
  reading.sample = sample(25);
  view.rerender(pane("second"));
  expect(visual("cpu").textContent).toBe("25%");
  expect(visual("gpu").textContent).toBe("20%");
  expect(frames.size).toBe(0);
});
