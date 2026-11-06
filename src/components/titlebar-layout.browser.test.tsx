import { afterEach, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { useState } from "react";
import { page } from "vitest/browser";
import { UpdateIndicator } from "./UpdateIndicator";
import { HostMetrics } from "./HostMetrics";
import { transitionFocusMode } from "../lib/focus-mode-transition";
import type { AppUpdateState } from "../lib/app-update";
import "../styles.css";

vi.mock("../hooks/use-header-metrics", () => ({
  useHeaderMetrics: () => ({
    visible: true,
    error: null,
    stale: false,
    sampling: false,
    history: [],
    refresh: () => undefined,
    sample: {
      sampledAt: "2026-11-05T16:00:00Z",
      cpuPercent: 42,
      coreCount: 4,
      memoryTotalKib: 4096,
      memoryAvailableKib: 2048,
      gpuPercent: null,
      diskReadBytesPerSecond: 1024,
      diskWriteBytesPerSecond: 2048,
      uptimeSeconds: 3600,
    },
  }),
}));

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  root?.unmount();
  container?.remove();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty("--motion-focus");
});

function mount(element: React.ReactNode) {
  container = document.createElement("div");
  container.style.height = "600px";
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(element));
}

it.each([1440, 960, 520])("keeps metrics still across update states at %ipx", async (width) => {
  await page.viewport(width, 700);
  let update!: (state: AppUpdateState) => void;
  const info = { version: "0.9.3", currentVersion: "0.9.2", notes: "", publishedAt: null };
  function Header() {
    const [state, setState] = useState<AppUpdateState>({ status: "available", info });
    update = setState;
    return (
      <div className="app-shell" data-focus-toggle="visible">
        <header className="app-bar">
          <HostMetrics
            target="local"
            name="Fixture machine"
            metrics={["cpu"]}
            seconds={5}
            onSettings={() => undefined}
          />
          <div className="app-bar-actions">
            <UpdateIndicator
              state={state}
              onDownload={() => undefined}
              onRestart={() => undefined}
            />
            <button className="app-bar-button" aria-label="Settings">
              S
            </button>
          </div>
        </header>
      </div>
    );
  }
  mount(<Header />);
  const metrics = container.querySelector(".host-metrics")!;
  const before = metrics.getBoundingClientRect();
  const valueBefore = metrics.querySelector(".host-metric")!.getBoundingClientRect();
  const states: AppUpdateState[] = [
    { status: "available", info },
    ...[0, 9, 10, 42, 99, 100].map((downloaded) => ({
      status: "downloading" as const,
      info,
      downloaded,
      total: 100,
    })),
    { status: "downloading", info, downloaded: 10, total: null },
    { status: "downloaded", info },
    { status: "installing", info },
    { status: "failed", info, failure: { kind: "download", message: "Offline" } },
  ];
  for (const state of states) {
    flushSync(() => update(state));
    const after = metrics.getBoundingClientRect();
    expect(after.x).toBe(before.x);
    expect(after.width).toBe(before.width);
    expect(metrics.querySelector(".host-metric")!.getBoundingClientRect().x).toBe(valueBefore.x);
    const button = container.querySelector(".update-indicator-button")!.getBoundingClientRect();
    expect(button.right).toBeLessThanOrEqual(width);
    expect(button.left).toBeGreaterThanOrEqual(0);
    expect(button.width).toBe(28);
    expect(button.height).toBe(28);
    expect(container.querySelector(".update-indicator-button")!.textContent).toBe("");
    if (state.status === "downloading" && state.total !== null)
      expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
        String(state.downloaded),
      );
    if (state.status !== "downloading" || state.downloaded === 42 || state.total === null) {
      await page.screenshot({
        element: container.querySelector(".app-bar")!,
        path: `../../test-results/update-icon-${width}-${state.status}${state.status === "downloading" && state.total === null ? "-unknown" : ""}.png`,
      });
    }
  }
});

it.each(["enter", "exit"] as const)(
  "interpolates live workspace extent on focus %s",
  async (direction) => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    document.documentElement.style.setProperty("--motion-focus", ".18s");
    let toggle!: () => void;
    function Workspace() {
      const [focus, setFocus] = useState(direction === "exit");
      toggle = () => setFocus(!focus);
      return (
        <div className={`app-shell ${focus ? "terminal-focus-mode" : ""}`}>
          <aside className="sidebar">Connections</aside>
          <header className="app-bar" />
          <main className="workspace-shell">
            <div data-live-terminal>Live terminal</div>
          </main>
        </div>
      );
    }
    mount(<Workspace />);
    const workspace = container.querySelector<HTMLElement>(".workspace-shell")!;
    const terminal = workspace.firstElementChild;
    const before = workspace.getBoundingClientRect();
    transitionFocusMode(direction, toggle);
    const motion = workspace.getAnimations()[0];
    expect(motion).toBeDefined();
    motion.pause();
    motion.currentTime = 90;
    const middle = workspace.getBoundingClientRect();
    motion.finish();
    await motion.finished;
    await vi.waitFor(() =>
      expect(document.documentElement.dataset.focusTransition).toBeUndefined(),
    );
    const after = workspace.getBoundingClientRect();
    expect(Math.abs(before.width - after.width)).toBeGreaterThan(100);
    expect(middle.width).toBeGreaterThan(Math.min(before.width, after.width) + 1);
    expect(middle.width).toBeLessThan(Math.max(before.width, after.width) - 1);
    expect(middle.height).toBeGreaterThan(Math.min(before.height, after.height) + 1);
    expect(middle.height).toBeLessThan(Math.max(before.height, after.height) - 1);
    expect(workspace.firstElementChild).toBe(terminal);
    expect(getComputedStyle(workspace).transform).toBe("none");
    expect(container.querySelector(".focus-departing-sidebar")).toBeNull();
  },
);
