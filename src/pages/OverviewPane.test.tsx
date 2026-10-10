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

import type { HostCapabilities, SavedConnection } from "../types";
import { OverviewPane } from "./OverviewPane";

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
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("OverviewPane", () => {
  it("shows host facts and capabilities without duplicate resource readings", async () => {
    renderPane();
    expect(await screen.findByText("Debian GNU/Linux 12")).toBeTruthy();
    const heading = screen.getByRole("heading", { name: "Overview" }).closest("header")!;
    expect(heading.textContent).not.toContain("debian");
    expect(heading.querySelector(".host-os-icon")).toBeNull();
    expect(screen.getAllByText("debian", { exact: true })).toHaveLength(1);
    for (const label of [
      "Architecture",
      "Default shell",
      "Running services",
      "Containers",
      "systemd",
      "journald",
      "Docker",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    for (const label of ["Live load", "CPU", "Memory", "Uptime"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /Pause|Resume/ })).toBeNull();
    expect(api.sampleHostResources).not.toHaveBeenCalled();
  });

  it("does not poll resource readings while open or after refreshing host facts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPane();
    await screen.findByText("Debian GNU/Linux 12");
    await vi.advanceTimersByTimeAsync(60_000);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.refreshCapabilities).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.sampleHostResources).not.toHaveBeenCalled();
  });

  it("refreshes cached host facts on request", async () => {
    const user = userEvent.setup();
    api.refreshCapabilities.mockResolvedValue(capabilities({ kernel: "new-kernel" }));
    renderPane();
    await screen.findByText("6.1.0-51-amd64");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("new-kernel")).toBeTruthy();
    expect(api.refreshCapabilities).toHaveBeenCalledWith(connection.id);
  });

  it("keeps cached facts and explains a failed refresh", async () => {
    const user = userEvent.setup();
    api.refreshCapabilities.mockRejectedValue(new Error("Host unavailable"));
    renderPane();
    await screen.findByText("Debian GNU/Linux 12");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
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
});
