// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  collectBootDiagnostics: vi.fn(),
  collectBootReplay: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type {
  BootDiagnostics,
  BootReplayPage,
  LogSourceSelection,
  SavedConnection,
} from "../types";
import { bootReplayPage, replayEntry } from "../test/boot-fixtures";
import { BootDiagnosticsPane } from "./BootDiagnosticsPane";

const connection: SavedConnection = {
  id: "connection-a",
  displayName: "Host A",
  destination: "host-a",
  username: "user",
  port: null,
  identityFile: null,
  historyEnabled: false,
  sudoEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

const currentId = "a".repeat(32);
const previousId = "b".repeat(32);
const collectedAt = "2026-08-31T12:00:00Z";

function snapshot(overrides: Partial<BootDiagnostics> = {}): BootDiagnostics {
  return {
    id: "diagnostic-a",
    collectedAt,
    selectedBootId: currentId,
    boots: {
      collectedAt,
      error: null,
      permissionRequired: false,
      data: [
        { index: -1, id: previousId, range: "Sat 2026-08-30 — Sat 2026-08-30", current: false },
        { index: 0, id: currentId, range: "Sun 2026-08-31 — Sun 2026-08-31", current: true },
      ],
    },
    timing: {
      collectedAt,
      error: null,
      permissionRequired: false,
      data: {
        total: "8.368s",
        kernel: "3.245s",
        userspace: "5.123s",
        original: "Startup finished in 3.245s (kernel) + 5.123s (userspace) = 8.368s",
      },
    },
    slowUnits: {
      collectedAt,
      error: null,
      permissionRequired: false,
      data: [{ unit: "network-online.target", duration: "2.400s" }],
    },
    failedUnits: {
      collectedAt,
      error: null,
      permissionRequired: false,
      data: [
        {
          id: "backup.service",
          unitType: "service",
          description: "Backup",
          loadState: "loaded",
          activeState: "failed",
          subState: "failed",
          unitFileState: "enabled",
        },
      ],
    },
    journal: {
      collectedAt,
      error: null,
      permissionRequired: false,
      data: ["warning: bounded evidence"],
    },
    ...overrides,
  };
}

function summaryTile(label: string): string | undefined {
  const summary = document.querySelector(".boot-summary");
  return [...(summary?.querySelectorAll(".overview-stat") ?? [])]
    .find((stat) => stat.querySelector(".overview-stat-label")?.textContent === label)
    ?.querySelector(".overview-stat-value")?.textContent;
}

function transportTime(): string {
  return document.querySelector(".boot-transport-time")?.textContent ?? "";
}

/** Representative retained evidence: a milestone, a unit start, a failed
 * service, and two identical warnings that should read as one cluster. */
function replayEvidencePage(overrides: Partial<BootReplayPage> = {}): BootReplayPage {
  return bootReplayPage({
    bootId: currentId,
    managerEvents: [
      replayEntry({
        id: "m-milestone",
        monotonicUs: 1_000_000,
        source: "systemd",
        message: "Reached target Basic System.",
      }),
      replayEntry({
        id: "m-unit",
        monotonicUs: 3_000_000,
        source: "systemd",
        message: "Started NetworkManager.service.",
      }),
    ],
    alertEvents: [
      replayEntry({
        id: "a-warn-1",
        monotonicUs: 10_000_000,
        priority: 4,
        source: "kernel",
        message: "wlan0: link is not ready",
      }),
      replayEntry({
        id: "a-warn-2",
        monotonicUs: 10_200_000,
        priority: 4,
        source: "kernel",
        message: "wlan0: link is not ready",
      }),
      replayEntry({
        id: "a-error",
        monotonicUs: 42_000_000,
        priority: 3,
        source: "nginx",
        unit: "nginx.service",
        message: "bind() failed",
      }),
      // systemd logs a second record moments after a unit fails, so failures
      // arrive in near-overlapping pairs.
      replayEntry({
        id: "a-error-2",
        monotonicUs: 43_100_000,
        priority: 3,
        source: "systemd",
        unit: "nginx.service",
        message: "Failed with result 'exit-code'.",
      }),
    ],
    earliestMonotonicUs: 0,
    latestMonotonicUs: 42_000_000,
    ...overrides,
  });
}

async function flushRendering(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {});
  }
}

/** Progresses on microtasks alone, so it works both under real timers and
 * under vi.useFakeTimers() for the playback tests. */
async function pollUntil(predicate: () => boolean, label = "condition", rounds = 60) {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return;
    await act(async () => {});
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("BootDiagnosticsPane", () => {
  beforeEach(() => {
    api.collectBootDiagnostics.mockReset().mockResolvedValue(snapshot());
    api.collectBootReplay.mockReset().mockResolvedValue(replayEvidencePage());
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** Mounts the pane, waits for the boot summary and the first replay page,
   * and rerenders with the fetched summary so the pane runs on real props. */
  async function loadPane(
    options: {
      snapshot?: BootDiagnostics | null;
      replay?: BootReplayPage;
      onOpenSystemd?(unit: string): void;
      onViewLogs?(source: LogSourceSelection): void;
    } = {},
  ) {
    const onOpenSystemd = options.onOpenSystemd ?? vi.fn();
    const onViewLogs = options.onViewLogs ?? vi.fn();
    const onSnapshotChange = vi.fn();
    if (options.replay !== undefined) {
      api.collectBootReplay.mockReset().mockResolvedValue(options.replay);
    }
    const props = {
      connection,
      snapshot: options.snapshot ?? null,
      onSnapshotChange,
      onViewLogs,
      onOpenSystemd,
    };
    const view = render(<BootDiagnosticsPane {...props} />);
    await pollUntil(() => onSnapshotChange.mock.calls.length > 0, "boot summary");
    const nextSnapshot = await api.collectBootDiagnostics.mock.results.at(-1)!.value;
    if (options.snapshot === undefined) {
      view.rerender(<BootDiagnosticsPane {...props} snapshot={nextSnapshot} />);
    }
    await pollUntil(() => api.collectBootReplay.mock.calls.length > 0, "first replay page");
    await flushRendering();
    return view;
  }

  it("mounts the Timeline Theater with the boot, window, and coverage", async () => {
    await loadPane();
    expect(screen.getByRole("heading", { name: "Boot Timeline" })).toBeTruthy();
    expect(screen.getByText("Recorded journal replay — the host is never rebooted.")).toBeTruthy();
    // Measured time, loaded notables, and an honest coverage reading.
    expect(summaryTile("Boot time")).toBe("8.368s");
    expect(summaryTile("Notable issues")).toBe("4");
    // The fixture journal ends before the 2-minute window, and the tile says
    // that in words instead of implying the whole window was retained.
    expect(summaryTile("Evidence")).toBe("Sized to journal");
    expect(api.collectBootReplay).toHaveBeenNthCalledWith(
      1,
      "connection-a",
      currentId,
      null,
      null,
      null,
    );
    expect(screen.getByRole("slider", { name: "Replay position in this window" })).toBeTruthy();
    expect(screen.getByLabelText("Replay speed")).toBeTruthy();
  });

  it("names boots by distance rather than by journalctl's negative index", async () => {
    await loadPane();
    const options = [...(screen.getByLabelText("Boot") as HTMLSelectElement).options];
    const labels = options.map((option) => option.textContent ?? "");
    expect(labels[0]).toMatch(/^Current boot/);
    expect(labels.some((label) => label.startsWith("1 boot ago"))).toBe(true);
    expect(labels.join(" ")).not.toContain("-1");
  });

  it("reveals markers as the playhead reaches their recorded offsets", async () => {
    await loadPane();
    const user = userEvent.setup();
    const seek = screen.getByRole("slider", { name: "Replay position in this window" });
    // Before anything is observed, no marker exists to read.
    expect(screen.queryByRole("button", { name: /Milestone at 1s/ })).toBeNull();
    fireEvent.change(seek, { target: { value: 2_000_000 } });
    await flushRendering(2);
    // Two seconds of this boot crossed the milestone but nothing later.
    expect(screen.getByRole("button", { name: /Milestone at 1s/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Unit event at 3s/ })).toBeNull();
    fireEvent.change(seek, { target: { value: 15_000_000 } });
    await flushRendering(2);
    expect(screen.getByRole("button", { name: /Unit event at 3s/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /2 similar events/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Failure at 42s/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Failure at 43s/ })).toBeNull();
    // Seeking backward restores the earlier state deterministically.
    fireEvent.change(seek, { target: { value: 1_500_000 } });
    await flushRendering(2);
    expect(screen.queryByRole("button", { name: /Unit event at 3s/ })).toBeNull();
    expect(screen.getByText(/At playhead: 1 event/)).toBeTruthy();
    void user;
  });

  it("plays the recorded evidence and reveals the clock as it runs", async () => {
    await loadPane();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Play replay" }));
    // One real second at 1x crosses the recorded milestone at T+1s.
    await new Promise((resolve) => setTimeout(resolve, 1150));
    await flushRendering(3);
    expect(screen.getByRole("button", { name: /Milestone at 1s/ })).toBeTruthy();
    expect(screen.getByRole("status")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Pause replay" }));
    // Pausing holds the exact position instead of drifting further.
    const paused = transportTime();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(transportTime()).toBe(paused);
  });

  it("opens marker evidence in the inspector without moving the playhead", async () => {
    await loadPane();
    const user = userEvent.setup();
    fireEvent.change(screen.getByRole("slider", { name: "Replay position in this window" }), {
      target: { value: 42_000_000 },
    });
    await flushRendering(2);
    const failureMarker = await screen.findByRole("button", {
      name: /Failure at 42s: bind\(\) failed/,
    });
    await user.click(failureMarker);
    const inspector = screen.getByLabelText("Replay event details");
    expect(inspector.textContent).toContain("T+0:42.0");
    expect(inspector.textContent).toContain("nginx.service reported an error");
    // Provenance is explicit: an observed journal record, nothing inferred.
    expect(screen.getByText(/Retained journal record — observed/)).toBeTruthy();
    expect(within(inspector).getByText("bind() failed")).toBeTruthy();
    // Clicking a marker opens evidence; it never moves the playhead.
    expect(transportTime()).toContain("T+0:42.0");
    await user.click(screen.getByRole("button", { name: "Close event details" }));
    expect(screen.queryByLabelText("Replay event details")).toBeNull();
    expect(transportTime()).toContain("T+0:42.0");
    // A clustered marker lists the repeats it stands for.
    await user.click(screen.getByRole("button", { name: /2 similar events/ }));
    const clusterInspector = screen.getByLabelText("Replay event details");
    expect(clusterInspector.textContent).toContain("2 similar events, from T+0:10.0");
  });

  it("steps distinct markers apart when they would paint over each other", async () => {
    await loadPane();
    // The two failure records land 0.8s apart — closer than one glyph width —
    // so the second one takes a step down the lane instead of overlapping.
    fireEvent.change(screen.getByRole("slider", { name: "Replay position in this window" }), {
      target: { value: 44_000_000 },
    });
    await flushRendering(2);
    const staggered = document.querySelector(".boot-marker-staggered");
    expect(staggered).toBeTruthy();
    expect(staggered?.getAttribute("aria-label")).toContain("Failed with result");
    // The earlier failure of the pair keeps its default row center.
    const bindMarker = screen.getByRole("button", { name: /Failure at 42s: bind\(\) failed/ });
    expect(bindMarker.className).not.toContain("boot-marker-staggered");
  });

  it("skips directly between notable events with previous and next", async () => {
    await loadPane();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next notable event" }));
    expect(transportTime()).toContain("T+0:10.0");
    await user.click(screen.getByRole("button", { name: "Next notable event" }));
    expect(transportTime()).toContain("T+0:42.0");
    // The paired failure record is its own stop, not lost in the cluster pair.
    await user.click(screen.getByRole("button", { name: "Next notable event" }));
    expect(transportTime()).toContain("T+0:43.1");
    await user.click(screen.getByRole("button", { name: "Previous notable event" }));
    expect(transportTime()).toContain("T+0:42.0");
    await user.click(screen.getByRole("button", { name: "Previous notable event" }));
    expect(transportTime()).toContain("T+0:10.0");
    // Before the first notable, Previous keeps the position instead of
    // inventing an earlier milestone.
    await user.click(screen.getByRole("button", { name: "Previous notable event" }));
    expect(transportTime()).toContain("T+0:10.0");
  });

  it("changes speed without moving the position and without another fetch", async () => {
    await loadPane();
    const user = userEvent.setup();
    expect(transportTime()).toContain("T+0:00.0");
    await user.selectOptions(screen.getByLabelText("Replay speed"), "5");
    expect(transportTime()).toContain("T+0:00.0");
    // Playback rate is client-side: speed changes never touch the host.
    expect(api.collectBootReplay).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Play replay" }));
    await user.click(screen.getByRole("button", { name: "Pause replay" }));
    expect(screen.getByRole("button", { name: "Play replay" })).toBeTruthy();
  });

  it("seeks by scrubbing the transport and rewinds with Restart", async () => {
    await loadPane();
    const seek = screen.getByRole("slider", { name: "Replay position in this window" });
    fireEvent.change(seek, { target: { value: 30_000_000 } });
    expect(transportTime()).toContain("T+0:30.0");
    expect(
      screen
        .getByRole("slider", { name: "Replay position in this window" })
        .getAttribute("aria-valuetext"),
    ).toContain("T+0:30.0");
    fireEvent.change(seek, { target: { value: 15_000_000 } });
    expect(transportTime()).toContain("T+0:15.0");
    await userEvent.click(
      screen.getByRole("button", { name: "Restart replay from the beginning" }),
    );
    expect(transportTime()).toContain("T+0:00.0");
  });

  it("lists loaded events in the journal lane and seeks from a row", async () => {
    await loadPane();
    const user = userEvent.setup();
    await user.click(screen.getByText("Show loaded events"));
    expect(screen.getByText("bind() failed")).toBeTruthy();
    await user.type(screen.getByLabelText("Search loaded events"), "wlan");
    expect(document.querySelectorAll(".boot-journal-rows li").length).toBe(2);
    await user.clear(screen.getByLabelText("Search loaded events"));
    // A row with no playhead yet is a direct jump: seek and open evidence.
    await flushRendering(2);
    const rows = [...document.querySelectorAll(".boot-journal-rows button")];
    const failureRow = rows.find((row) => row.textContent?.includes("bind() failed"));
    await user.click(failureRow!);
    expect(transportTime()).toContain("T+0:42.0");
    expect(screen.getByText(/nginx.service reported an error/)).toBeTruthy();
    expect(document.querySelector(".boot-journal-rows button.at-playhead")?.textContent).toContain(
      "bind() failed",
    );
  });

  it("offers Load more only while a bounded stream still has retained pages", async () => {
    const truncatedPage = replayEvidencePage({
      managerNextCursor: "s=first",
      managerTruncated: true,
      alertNextCursor: "s=alert",
      alertTruncated: true,
    });
    api.collectBootReplay.mockReset().mockResolvedValue(truncatedPage);
    await loadPane();
    // Auto-pagination stops at its page budget rather than reading forever.
    await pollUntil(() => api.collectBootReplay.mock.calls.length === 4, "auto pages");
    await userEvent.click(screen.getByText("Show loaded events"));
    expect(screen.getByRole("button", { name: "Load more retained events" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Load more retained events" }));
    await pollUntil(() => api.collectBootReplay.mock.calls.length > 4, "next page");
    // The next page starts from the journal cursors, not the boot start.
    expect(api.collectBootReplay).toHaveBeenLastCalledWith(
      "connection-a",
      currentId,
      "s=first",
      "s=alert",
      null,
    );
  });

  it("switches to a historical boot, stops playback, and reads only its evidence", async () => {
    const previousSnapshot = snapshot({ selectedBootId: previousId });
    const view = await loadPane();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Play replay" }));
    await user.selectOptions(screen.getByLabelText("Boot"), previousId);
    await pollUntil(
      () => api.collectBootDiagnostics.mock.calls.some(([, bootId]) => bootId === previousId),
      "diagnostics for the previous boot",
    );
    api.collectBootReplay.mockClear();
    view.rerender(
      <BootDiagnosticsPane
        connection={connection}
        snapshot={previousSnapshot}
        onSnapshotChange={vi.fn()}
        onViewLogs={vi.fn()}
        onOpenSystemd={undefined}
      />,
    );
    await pollUntil(
      () => api.collectBootReplay.mock.calls.some(([, bootId]) => bootId === previousId),
      "replay evidence for the previous boot",
    );
    // Playback did not survive the boot switch, and no current-only facts
    // were inherited from the running system.
    expect(screen.getByRole("button", { name: "Play replay" })).toBeTruthy();
    expect(summaryTile("Boot time")).toBe("Not measured");
    expect(document.querySelector(".boot-current-diagnostics")).toBeNull();
  });

  it("shows current-boot diagnostics as a disclosure with real unit links", async () => {
    const onOpenSystemd = vi.fn();
    const onViewLogs = vi.fn();
    await loadPane({ onOpenSystemd, onViewLogs });
    const user = userEvent.setup();
    await user.click(screen.getByText("Current-boot diagnostics"));
    expect(screen.getByText("Slow units")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "backup.service" }));
    expect(onOpenSystemd).toHaveBeenLastCalledWith("backup.service");
    await user.click(screen.getByRole("button", { name: "View journal" }));
    expect(onViewLogs).toHaveBeenCalledWith({ type: "systemd", id: "backup.service" });
  });

  it("tells a permission wall apart from a read failure and retries elevated", async () => {
    const permissionPage = replayEvidencePage({
      managerEvents: [],
      alertEvents: [],
      permissionRequired: true,
      errors: ["Boot journal requires permission"],
    });
    await loadPane({ replay: permissionPage });
    expect(screen.getAllByText(/cannot read this boot's journal/).length).toBeGreaterThan(0);
    expect(summaryTile("Evidence")).toBe("Needs permission");
    // With nothing loaded, "Notable issues" refuses to show a zero that could
    // be misread as a clean bill of health.
    expect(summaryTile("Notable issues")).toBe("—");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry with sudo" }));
    const password = screen.getByText("Password").closest("label")?.querySelector("input");
    expect(password).toBeTruthy();
    await user.type(password!, "one-time-password");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await pollUntil(
      () =>
        api.collectBootReplay.mock.calls.some(
          ([, , , , password]) => password === "one-time-password",
        ),
      "elevated evidence retry",
    );
  });

  it("offers a retry when the evidence read fails and keeps the summary honest", async () => {
    api.collectBootReplay.mockReset().mockRejectedValue(new Error("SSH fixture failure"));
    await loadPane();
    expect(screen.getAllByText(/SSH fixture failure/).length).toBeGreaterThan(0);
    expect(summaryTile("Evidence")).toBe("Unavailable");
    expect(screen.getByRole("button", { name: "Retry reading the journal" })).toBeTruthy();
    api.collectBootReplay.mockResolvedValue(replayEvidencePage());
    await userEvent.click(screen.getByRole("button", { name: "Retry reading the journal" }));
    await pollUntil(
      () => !!screen.queryByRole("button", { name: /^Play replay$/ }),
      "recovered transport",
    );
  });

  it("distinguishes a boot with no retained records from a matched search", async () => {
    const emptyPage = replayEvidencePage({
      managerEvents: [],
      alertEvents: [],
      earliestMonotonicUs: null,
      latestMonotonicUs: null,
    });
    await loadPane({ replay: emptyPage });
    expect(screen.getByText("No events were retained in this replay window.")).toBeTruthy();
    expect(summaryTile("Notable issues")).toBe("—");
    expect(summaryTile("Evidence")).toBe("No records");
    await userEvent.click(screen.getByText("Show loaded events"));
    expect(screen.getByText(/Everything retained for these filters has been loaded/)).toBeTruthy();
  });
});
