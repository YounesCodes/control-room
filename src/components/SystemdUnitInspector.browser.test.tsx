import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SystemdUnitInspector } from "./SystemdUnitInspector";
import { systemdInspection } from "../test/systemd-fixtures";
import "../styles.css";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("interpolates memory, retargets from its displayed reading, and cancels on removal", () => {
  let now = 0;
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const props = (memory: string, unitId = "worker.service") => ({
    connectionId: "memory-test",
    unitId,
    summary: null,
    revision: 0,
    result: {
      value: systemdInspection(unitId, { MemoryCurrent: memory }),
      fetchedAt: Date.now(),
      loading: false,
      error: null,
    },
    onRefresh: vi.fn(),
    onViewLogs: vi.fn(),
  });
  const view = render(<SystemdUnitInspector {...props("104857600")} />);
  const visual = () =>
    document.querySelector<HTMLElement>(".systemd-memory-value > [aria-hidden]")!;
  const value = () => parseFloat(visual().textContent!.replace(",", "."));
  const tick = (elapsed: number) => {
    now += elapsed;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(now));
  };
  expect(value()).toBe(100);
  expect(frames.size).toBe(0);
  expect(getComputedStyle(visual().parentElement!).fontVariantNumeric).toBe("tabular-nums");
  view.rerender(<SystemdUnitInspector {...props("209715200")} />);
  expect(document.querySelector(".systemd-memory-value .sr-only")!.textContent).toBe("200 MiB");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    expect(value()).toBe(200);
    expect(frames.size).toBe(0);
  } else {
    const duration = parseFloat(getComputedStyle(visual()).getPropertyValue("--motion-slow"));
    expect(value()).toBe(100);
    tick(duration / 2);
    expect(value()).toBeGreaterThan(100);
    expect(value()).toBeLessThan(200);
    const midway = value();
    view.rerender(<SystemdUnitInspector {...props("52428800")} />);
    expect(value()).toBe(midway);
    expect(frames.size).toBe(1);
    tick(duration / 2);
    expect(value()).toBeLessThan(midway);
    expect(value()).toBeGreaterThan(50);
    tick(duration / 2);
    expect(value()).toBe(50);
    expect(frames.size).toBe(0);
    view.rerender(<SystemdUnitInspector {...props("314572800")} />);
    expect(frames.size).toBe(1);
    view.rerender(<SystemdUnitInspector {...props("18446744073709551615")} />);
    expect(screen.queryByText("Memory")).toBeNull();
    expect(frames.size).toBe(0);
    view.rerender(<SystemdUnitInspector {...props("419430400")} />);
    expect(value()).toBe(400);
    expect(frames.size).toBe(0);
    view.rerender(<SystemdUnitInspector {...props("524288000")} />);
    expect(frames.size).toBe(1);
  }
  view.unmount();
  expect(frames.size).toBe(0);
});
