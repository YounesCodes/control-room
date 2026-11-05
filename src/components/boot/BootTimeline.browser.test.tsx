import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { BootTimeline } from "./BootTimeline";
import { groupReplayMarkers, toReplayEvent } from "../../lib/boot-replay";
import { replayEntry } from "../../test/boot-fixtures";
import "../../styles.css";

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  root?.unmount();
  container?.remove();
});

it.each([600, 1200])(
  "aligns markers, the live playhead, and pointer seeking at %s px",
  async (width) => {
    await page.viewport(width + 80, 700);
    container = document.createElement("div");
    container.style.cssText = `width:${width}px;margin:20px`;
    document.body.append(container);
    root = createRoot(container);
    const onSeek = vi.fn();
    const markers = groupReplayMarkers(
      [toReplayEvent(replayEntry({ monotonicUs: 60_000_000, priority: 3 }))],
      120_000_000,
    );
    root.render(
      <BootTimeline
        windowUs={120_000_000}
        positionUs={60_000_000}
        lanes={[{ id: "alerts", label: "Warnings & failures", markers }]}
        selectedMarkerKey={null}
        onSeek={onSeek}
        onSelectMarker={vi.fn()}
        axisRef={{ current: null }}
      />,
    );
    await expect.element(page.getByRole("button", { name: /Failure at 60s/ })).toBeVisible();
    const plot = container.querySelector<HTMLElement>(".boot-timeline-plot")!;
    const track = container.querySelector<HTMLElement>(".boot-lane-track")!;
    const playhead = container.querySelector<HTMLElement>(".boot-playhead")!;
    const bounds = track.getBoundingClientRect();
    expect(
      Math.abs(playhead.getBoundingClientRect().left - (bounds.left + bounds.width / 2)),
    ).toBeLessThan(1);
    plot.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: bounds.left + bounds.width / 4 }),
    );
    // Mouse coordinates are rounded to whole CSS pixels by Chromium.
    expect(Math.abs(onSeek.mock.lastCall![0] - 30_000_000)).toBeLessThan(
      120_000_000 / bounds.width,
    );
    const timeline = container.querySelector<HTMLElement>(".boot-timeline")!;
    timeline.style.setProperty("--replay-progress", "0.75");
    expect(
      Math.abs(playhead.getBoundingClientRect().left - (bounds.left + bounds.width * 0.75)),
    ).toBeLessThan(1);
    await userEvent.tab();
    await expect.element(page.getByRole("button", { name: /Failure at 60s/ })).toHaveFocus();
  },
);
