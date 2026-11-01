// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  cachedCapabilities: vi.fn(),
  refreshCapabilities: vi.fn(),
  sampleHostResources: vi.fn(),
  sampleOverviewDiagnostics: vi.fn(),
  listHostBaselines: vi.fn(),
  compareHostBaselines: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type { HostCapabilities, SavedConnection } from "../types";
import { OverviewPane } from "./OverviewPane";
import { baseline, comparison, diagnostics, summary } from "../test/app-fixtures";

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

function renderPane(caps: HostCapabilities = capabilities()) {
  api.cachedCapabilities.mockResolvedValue(caps);
  return render(<OverviewPane connection={connection} />);
}

beforeEach(() => {
  api.cachedCapabilities.mockResolvedValue(capabilities());
  api.refreshCapabilities.mockResolvedValue(capabilities());
  api.sampleOverviewDiagnostics.mockImplementation(async () => diagnostics());
  api.listHostBaselines.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("OverviewPane", () => {
  it("summarizes saved configuration changes and links the exact comparison", async () => {
    const old = { ...baseline("old"), capturedAt: "2026-10-01T10:00:00Z" };
    const recent = { ...baseline("recent"), capturedAt: "2026-10-02T10:00:00Z" };
    const diff = comparison(old, recent);
    diff.sections[0].changed = [
      {
        identity: "host",
        label: "Host",
        changes: [{ name: "kernel", baseValue: "6.8", targetValue: "6.9" }],
      },
    ];
    api.listHostBaselines.mockResolvedValue([
      summary(old),
      { ...summary(recent), changesSincePrevious: 1 },
    ]);
    api.compareHostBaselines.mockResolvedValue(diff);
    const navigate = vi.fn();
    render(<OverviewPane connection={connection} onNavigate={navigate} />);
    expect(await screen.findByText(/Latest saved comparison.*1 changed/)).toBeTruthy();
    expect(api.compareHostBaselines).toHaveBeenCalledWith("old", "recent");
    await userEvent.click(screen.getByRole("button", { name: "1 change" }));
    expect(navigate).toHaveBeenCalledWith("baselines", "recent", "old");
  });
  it("does not publish host facts from a refresh after the pane is unmounted", async () => {
    let finish!: (value: HostCapabilities) => void;
    api.refreshCapabilities.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const changed = vi.fn();
    const view = render(<OverviewPane connection={connection} onCapabilitiesChange={changed} />);
    await screen.findByText("Debian GNU/Linux 12");
    await userEvent.click(screen.getByRole("button", { name: "Refresh facts" }));
    view.unmount();
    await act(async () => finish(capabilities({ hostname: "old-host" })));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("shows live diagnostics beside cached host facts", async () => {
    renderPane();
    expect(await screen.findByText("Debian GNU/Linux 12")).toBeTruthy();
    const heading = screen.getByRole("heading", { name: "Overview" }).closest("header")!;
    expect(heading.textContent).not.toContain("debian");
    expect(heading.querySelector(".host-os-icon")).toBeNull();
    expect(screen.getAllByText("debian", { exact: true })).toHaveLength(1);
    for (const label of ["Architecture", "Default shell", "systemd", "journald", "Docker"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    for (const label of ["CPU", "Memory", "Network", "Processes", "Storage", "Workloads", "Uptime"])
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(await screen.findByText("Live", { exact: true })).toBeTruthy();
    expect(screen.getByText(/Cached facts/)).toBeTruthy();
    expect(api.sampleOverviewDiagnostics).toHaveBeenCalledWith(connection.id, true);
    expect(api.sampleHostResources).not.toHaveBeenCalled();
  });

  it("pauses diagnostics without discarding cached facts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPane();
    await screen.findByText("Debian GNU/Linux 12");
    await screen.findByText("Live", { exact: true });
    await user.click(screen.getByRole("button", { name: "Pause" }));
    const reads = api.sampleOverviewDiagnostics.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await user.click(screen.getByRole("button", { name: "Refresh facts" }));
    await waitFor(() => expect(api.refreshCapabilities).toHaveBeenCalledTimes(1));
    expect(api.sampleOverviewDiagnostics).toHaveBeenCalledTimes(reads);
    expect(api.sampleHostResources).not.toHaveBeenCalled();
  });

  it("refreshes cached host facts on request", async () => {
    const user = userEvent.setup();
    api.refreshCapabilities.mockResolvedValue(capabilities({ kernel: "new-kernel" }));
    renderPane();
    await screen.findByText("6.1.0-51-amd64");
    await user.click(screen.getByRole("button", { name: "Refresh facts" }));
    expect(await screen.findByText("new-kernel")).toBeTruthy();
    expect(api.refreshCapabilities).toHaveBeenCalledWith(connection.id);
  });

  it("keeps cached facts and explains a failed refresh", async () => {
    const user = userEvent.setup();
    api.refreshCapabilities.mockRejectedValue(new Error("Host unavailable"));
    renderPane();
    await screen.findByText("Debian GNU/Linux 12");
    await user.click(screen.getByRole("button", { name: "Refresh facts" }));
    expect(await screen.findByText(/Showing cached data.*Host unavailable/)).toBeTruthy();
    expect(screen.getByText("Debian GNU/Linux 12")).toBeTruthy();
  });

  it("discovers capabilities when no cached facts exist", async () => {
    api.cachedCapabilities.mockResolvedValue(null);
    render(<OverviewPane connection={connection} />);
    expect(await screen.findByText("Debian GNU/Linux 12")).toBeTruthy();
    expect(api.refreshCapabilities).toHaveBeenCalledWith(connection.id);
  });

  it("says so when the cached host facts are a day old", async () => {
    const old = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString();
    renderPane(capabilities({ detectedAt: old }));
    expect(await screen.findByText(/have not been\s+re-read since/)).toBeTruthy();
  });

  it("does not mark a fresh inspection as stale", async () => {
    renderPane();
    await screen.findByText("Debian GNU/Linux 12");
    expect(screen.queryByText(/have not been/)).toBeNull();
  });
  it("shows Windows identity without Linux service counts or sudo advice", async () => {
    renderPane(
      capabilities({
        osId: "windows",
        osName: "Windows 11 Pro",
        osVersion: "10.0.26100",
        defaultShell: "cmd.exe",
      }),
    );
    await screen.findByText("Windows 11 Pro 10.0.26100");
    expect(screen.getByText("Windows services")).toBeTruthy();
    expect(screen.getByText("TCP and UDP listeners")).toBeTruthy();
    expect(screen.getByText("Unsupported on Windows")).toBeTruthy();
    expect(screen.queryByText("Password required")).toBeNull();
  });
  it("sorts process consumers and navigates to the existing workload inspectors", async () => {
    const navigate = vi.fn();
    render(<OverviewPane connection={connection} onNavigate={navigate} />);
    await screen.findByText("worker");
    const table = screen.getByText("worker").closest("table")!;
    expect(table.querySelector("tbody tr")!.textContent).toContain("worker");
    await userEvent.click(screen.getByRole("button", { name: "Memory" }));
    expect(table.querySelector("tbody tr")!.textContent).toContain("database");
    await userEvent.click(screen.getByRole("button", { name: "Systemd" }));
    expect(navigate).toHaveBeenCalledWith("services", undefined, undefined);
    await userEvent.click(screen.getByRole("button", { name: "Listening ports" }));
    expect(navigate).toHaveBeenCalledWith("ports", undefined, undefined);
  });
});
