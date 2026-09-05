// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  cachedCapabilities: vi.fn(),
  refreshCapabilities: vi.fn(),
  sampleHostResources: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type { HostCapabilities, HostResources, SavedConnection } from "../types";
import { OverviewPane } from "./OverviewPane";
import { SAMPLE_INTERVAL_MS } from "../lib/use-host-resources";

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

function capabilities(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    connectionId: "connection-a",
    hostname: "debian",
    osId: "debian",
    osName: "Debian GNU/Linux",
    osVersion: "12",
    kernel: "6.1.0-51-amd64",
    architecture: "x86_64",
    uptime: "up 1 week, 2 days, 2 hours, 55 minutes",
    defaultShell: "/bin/bash",
    systemdAvailable: true,
    journaldAvailable: true,
    dockerAvailable: true,
    dockerAccessible: true,
    dockerAccessibleWithSudo: false,
    passwordlessSudo: false,
    dockerVersion: "29.6.2",
    runningServiceCount: 20,
    runningContainerCount: 0,
    totalContainerCount: 0,
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function sample(overrides: Partial<HostResources> = {}): HostResources {
  return {
    sampledAt: new Date().toISOString(),
    cpuPercent: 12.5,
    coreCount: 4,
    load1: 0.1,
    load5: 0.2,
    load15: 0.3,
    memoryTotalKib: 3_884_504,
    memoryAvailableKib: 3_134_880,
    swapTotalKib: 1_003_516,
    swapFreeKib: 1_002_736,
    ...overrides,
  };
}

function renderPane(caps: HostCapabilities = capabilities()) {
  api.cachedCapabilities.mockResolvedValue(caps);
  return render(<OverviewPane connection={connection} />);
}

beforeEach(() => {
  api.cachedCapabilities.mockResolvedValue(capabilities());
  api.refreshCapabilities.mockResolvedValue(capabilities());
  api.sampleHostResources.mockResolvedValue(sample());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("OverviewPane", () => {
  it("shows current load and shortens the prose uptime", async () => {
    renderPane();

    expect(await screen.findByText("13%")).toBeTruthy();
    expect(screen.getByText(/load 0\.10 over 4 cores/)).toBeTruthy();
    // 749624 KiB used of 3884504, and readings past 100 drop the decimal.
    expect(screen.getByText(/732 MiB of 3\.7 GiB/)).toBeTruthy();
    // "up 1 week, 2 days, 2 hours, 55 minutes" would wrap the stat to two lines.
    expect(screen.getByText("1w 2d")).toBeTruthy();
    expect(screen.queryByText(/2 hours, 55 minutes/)).toBeNull();
  });

  it("keeps sampling on an interval while the pane is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPane();
    await waitFor(() => expect(api.sampleHostResources).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS + 50);
    expect(api.sampleHostResources).toHaveBeenCalledTimes(2);
  });

  // The pane is the only thing keeping the timer alive. Navigating away has to
  // stop talking to the host, or an on-demand read becomes monitoring.
  it("stops sampling once the pane unmounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = renderPane();
    await waitFor(() => expect(api.sampleHostResources).toHaveBeenCalledTimes(1));

    view.unmount();
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 3);
    expect(api.sampleHostResources).toHaveBeenCalledTimes(1);
  });

  it("stops sampling when paused and resumes on request", async () => {
    // Installed before render so the hook's first schedule() is a fake timer;
    // installing it afterwards leaves a real timeout this test cannot control.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPane();
    await waitFor(() => expect(api.sampleHostResources).toHaveBeenCalledTimes(1));

    // findByRole, not getByRole: the sample call resolving is not the same
    // moment as React committing the render that shows the button, and under
    // load the two can be far enough apart to fail a synchronous lookup.
    await user.click(await screen.findByRole("button", { name: /Pause/ }));
    const afterPause = api.sampleHostResources.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 3);
    expect(api.sampleHostResources).toHaveBeenCalledTimes(afterPause);

    await user.click(await screen.findByRole("button", { name: /Resume/ }));
    await waitFor(() =>
      expect(api.sampleHostResources.mock.calls.length).toBeGreaterThan(afterPause),
    );
  });

  it("keeps the last reading when a sample fails instead of blanking the chart", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPane();
    await waitFor(() => expect(screen.getByText("13%")).toBeTruthy());

    api.sampleHostResources.mockRejectedValue(new Error("Structured read queue is busy"));
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS + 50);

    await waitFor(() => expect(screen.getByText(/Structured read queue is busy/)).toBeTruthy());
    expect(screen.getByText("13%")).toBeTruthy();
  });

  it("says so when the cached host facts are a day old", async () => {
    const old = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString();
    renderPane(capabilities({ detectedAt: old }));

    expect(await screen.findByText(/have not been\s+re-read since/)).toBeTruthy();
  });

  it("does not cry stale over a fresh inspection", async () => {
    renderPane();
    await screen.findByText("13%");
    expect(screen.queryByText(/have not been/)).toBeNull();
  });

  it("reports a missing reading as unavailable rather than as an idle host", async () => {
    api.sampleHostResources.mockResolvedValue(sample({ cpuPercent: null }));
    renderPane();

    expect(await screen.findByText("/proc/stat was not readable")).toBeTruthy();
  });
});
