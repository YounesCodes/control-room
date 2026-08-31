// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  beginResourceCollection: vi.fn(),
  collectResources: vi.fn(),
  cancelResourceCollection: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type { ResourceSnapshot, SavedConnection } from "../types";
import { ResourcesPane } from "./ResourcesPane";

const connection: SavedConnection = {
  id: "connection-a",
  displayName: "Host A",
  destination: "host-a",
  username: "user",
  port: null,
  identityFile: null,
  historyEnabled: false,
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

const collectedAt = "2026-08-31T12:00:00Z";

function snapshot(): ResourceSnapshot {
  return {
    id: "operation-a",
    collectedAt,
    cpu: {
      collectedAt,
      error: null,
      data: { cpuCount: 4, loadOne: 1.2, loadFive: 0.8, loadFifteen: 0.4 },
    },
    memory: {
      collectedAt,
      error: null,
      data: {
        totalBytes: 8 * 1024 ** 3,
        availableBytes: 5 * 1024 ** 3,
        usedBytes: 3 * 1024 ** 3,
        swapTotalBytes: 2 * 1024 ** 3,
        swapUsedBytes: 512 * 1024 ** 2,
      },
    },
    filesystems: {
      collectedAt,
      error: "Filesystem data unavailable",
      data: null,
    },
    processes: {
      collectedAt,
      error: null,
      data: {
        sort: "CPU usage descending",
        limit: 10,
        rows: [{ pid: 42, user: "www-data", cpuPercent: 8.5, memoryPercent: 2.1, name: "nginx" }],
      },
    },
  };
}

describe("ResourcesPane", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "operation-a") });
    api.beginResourceCollection.mockResolvedValue(undefined);
    api.cancelResourceCollection.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("collects once on open and renders typed results with a partial section failure", async () => {
    api.collectResources.mockResolvedValue(snapshot());
    const onSnapshotChange = vi.fn();
    const { rerender } = render(
      <ResourcesPane connection={connection} snapshot={null} onSnapshotChange={onSnapshotChange} />,
    );

    await waitFor(() => expect(onSnapshotChange).toHaveBeenCalledWith(snapshot()));
    rerender(
      <ResourcesPane
        connection={connection}
        snapshot={snapshot()}
        onSnapshotChange={onSnapshotChange}
      />,
    );

    expect(api.collectResources).toHaveBeenCalledWith("connection-a", "operation-a");
    expect(screen.getByText("1.20")).toBeTruthy();
    expect(screen.getByText(/against 4 logical CPUs/i)).toBeTruthy();
    expect(screen.getByText("Filesystem data unavailable")).toBeTruthy();
    expect(screen.getByText("nginx")).toBeTruthy();
    expect(screen.getByText(/Command arguments are not collected/i)).toBeTruthy();
  });

  it("locks refresh while collecting and cancels the backend operation", async () => {
    const user = userEvent.setup();
    api.collectResources.mockReturnValue(new Promise(() => undefined));
    render(
      <ResourcesPane connection={connection} snapshot={snapshot()} onSnapshotChange={vi.fn()} />,
    );

    const cancel = await screen.findByRole("button", { name: "Cancel" });
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    await user.click(cancel);

    expect(api.cancelResourceCollection).toHaveBeenCalledWith("operation-a");
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeTruthy();
  });
});
