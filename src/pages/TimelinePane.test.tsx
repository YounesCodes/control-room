// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineEvent } from "../types";
import { TimelinePane } from "./TimelinePane";

function event(overrides: Partial<TimelineEvent> & { id: string }): TimelineEvent {
  return {
    at: "2026-09-01T10:00:00Z",
    kind: "command",
    label: "uptime",
    detail: null,
    target: null,
    repeatCount: 1,
    ...overrides,
  };
}

afterEach(cleanup);

describe("timeline pane", () => {
  it("says the record lives in memory and is lost on close", () => {
    render(<TimelinePane timeline={[]} historyEnabled onClear={vi.fn()} onOpenTarget={vi.fn()} />);
    expect(
      screen.getByText("Held in memory for this Workspace only. Closing Control Room clears it."),
    ).toBeTruthy();
    expect(screen.getByText("Nothing recorded yet")).toBeTruthy();
  });

  it("explains that commands are missing when Enhanced History is off", () => {
    render(
      <TimelinePane
        timeline={[event({ id: "a", kind: "connected", label: "Connected" })]}
        historyEnabled={false}
        onClear={vi.fn()}
        onOpenTarget={vi.fn()}
      />,
    );
    expect(screen.getByText(/commands are not recorded/)).toBeTruthy();
  });

  it("shows a repeat count instead of duplicate rows", () => {
    render(
      <TimelinePane
        timeline={[event({ id: "a", repeatCount: 4, detail: "exit 0" })]}
        historyEnabled
        onClear={vi.fn()}
        onOpenTarget={vi.fn()}
      />,
    );
    expect(screen.getByText("repeated 4 times")).toBeTruthy();
    expect(screen.getAllByText("uptime")).toHaveLength(1);
  });

  it("offers navigation only for objects that can still be opened", async () => {
    const onOpenTarget = vi.fn();
    render(
      <TimelinePane
        timeline={[
          event({
            id: "a",
            kind: "openedObject",
            label: "Opened unit nginx.service",
            target: { type: "systemdUnit", id: "nginx.service" },
          }),
          event({
            id: "b",
            kind: "logStreamStarted",
            label: "Started journal stream for nginx.service",
            target: { type: "logSource", id: "nginx.service", sourceType: "systemd" },
          }),
        ]}
        historyEnabled
        onClear={vi.fn()}
        onOpenTarget={onOpenTarget}
      />,
    );
    const openButtons = screen.getAllByRole("button", { name: "Open" });
    expect(openButtons).toHaveLength(1);
    await userEvent.click(openButtons[0]);
    expect(onOpenTarget).toHaveBeenCalledWith({ type: "systemdUnit", id: "nginx.service" });
  });

  it("clears the record on request", async () => {
    const onClear = vi.fn();
    render(
      <TimelinePane
        timeline={[event({ id: "a" })]}
        historyEnabled
        onClear={onClear}
        onOpenTarget={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear timeline" }));
    expect(onClear).toHaveBeenCalled();
  });
});
