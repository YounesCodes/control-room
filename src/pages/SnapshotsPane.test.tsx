// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listHostSnapshots: vi.fn(),
  getHostSnapshot: vi.fn(),
  captureHostSnapshot: vi.fn(),
  cancelHostSnapshot: vi.fn(),
  renameHostSnapshot: vi.fn(),
  deleteHostSnapshot: vi.fn(),
  compareHostSnapshots: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;
  },
}));

import type {
  HostSnapshot,
  HostSnapshotSummary,
  SavedConnection,
  SnapshotComparison,
} from "../types";
import { SnapshotsPane } from "./SnapshotsPane";

const connection: SavedConnection = {
  id: "connection-a",
  displayName: "Host A",
  destination: "host-a",
  username: "user",
  port: null,
  identityFile: null,
  historyEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

const identity = {
  hostname: "host-a",
  machineFingerprint: "0123456789abcdef",
  osId: "debian",
  osVersion: "13",
  kernel: "6.1.0",
  architecture: "x86_64",
};

function summary(id: string, capturedAt: string, label: string | null): HostSnapshotSummary {
  return {
    id,
    connectionId: connection.id,
    label,
    schemaVersion: 1,
    capturedAt,
    identity,
    sections: [
      { kind: "host", status: "collected", entryCount: 1 },
      { kind: "systemdUnits", status: "collected", entryCount: 40 },
      { kind: "containers", status: "unsupported", entryCount: 0 },
      { kind: "listeners", status: "partial", entryCount: 7 },
      { kind: "filesystems", status: "collected", entryCount: 3 },
    ],
  };
}

const detail: HostSnapshot = {
  id: "later",
  connectionId: connection.id,
  label: "after upgrade",
  schemaVersion: 1,
  capturedAt: "2026-09-02T10:00:00Z",
  identity,
  sections: [
    {
      kind: "host",
      status: "collected",
      collectedAt: "2026-09-02T10:00:00Z",
      message: null,
      entries: [
        {
          identity: "host",
          label: "host-a",
          facts: [{ name: "kernel", value: "6.1.0" }],
        },
      ],
    },
    {
      kind: "containers",
      status: "unsupported",
      collectedAt: "2026-09-02T10:00:00Z",
      message: "Docker is not installed",
      entries: [],
    },
  ],
};

const comparison: SnapshotComparison = {
  base: summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
  target: summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
  identityMatch: "same",
  schemaCompatible: true,
  sections: [
    {
      kind: "systemdUnits",
      baseStatus: "collected",
      targetStatus: "collected",
      comparable: true,
      note: null,
      added: [{ identity: "postgresql.service", label: "postgresql.service", facts: [] }],
      removed: [{ identity: "nginx.service", label: "nginx.service", facts: [] }],
      changed: [
        {
          identity: "ssh.service",
          label: "ssh.service",
          changes: [{ name: "activeState", baseValue: "active", targetValue: "failed" }],
        },
      ],
      unchangedCount: 37,
    },
    {
      kind: "containers",
      baseStatus: "collected",
      targetStatus: "unsupported",
      comparable: false,
      note: "Not comparable: in the later capture the subsystem was not present.",
      added: [],
      removed: [],
      changed: [],
      unchangedCount: 0,
    },
  ],
};

function renderPane(selectedId: string | null = "later") {
  const onSelect = vi.fn();
  render(<SnapshotsPane connection={connection} selectedId={selectedId} onSelect={onSelect} />);
  return onSelect;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("snapshots pane", () => {
  it("lists saved captures and says capture is manual", async () => {
    api.listHostSnapshots.mockResolvedValue([
      summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
    ]);
    api.getHostSnapshot.mockResolvedValue(detail);
    renderPane();
    expect(await screen.findAllByText("before upgrade")).not.toHaveLength(0);
    expect(screen.getAllByText("after upgrade")).not.toHaveLength(0);
    expect(
      screen.getByText(
        "Captured only when you ask. Control Room never collects in the background.",
      ),
    ).toBeTruthy();
  });

  it("shows an unsupported section in the detail instead of hiding it", async () => {
    api.listHostSnapshots.mockResolvedValue([summary("later", "2026-09-02T10:00:00Z", null)]);
    api.getHostSnapshot.mockResolvedValue(detail);
    renderPane();
    expect(await screen.findByText("Containers")).toBeTruthy();
    expect(screen.getByText("Not present")).toBeTruthy();
    expect(screen.getByText("Docker is not installed")).toBeTruthy();
  });

  it("compares earlier to later whichever capture is selected", async () => {
    api.listHostSnapshots.mockResolvedValue([
      summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
    ]);
    api.getHostSnapshot.mockResolvedValue(detail);
    api.compareHostSnapshots.mockResolvedValue(comparison);
    renderPane("later");
    await screen.findAllByText("before upgrade");
    await userEvent.selectOptions(screen.getByRole("combobox"), "earlier");
    await waitFor(() => expect(api.compareHostSnapshots).toHaveBeenCalledWith("earlier", "later"));
    expect(await screen.findByText("postgresql.service")).toBeTruthy();
    expect(screen.getByText("nginx.service")).toBeTruthy();
    expect(screen.getByText("ssh.service")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
  });

  it("reports a section it could not compare rather than calling it unchanged", async () => {
    api.listHostSnapshots.mockResolvedValue([
      summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
    ]);
    api.getHostSnapshot.mockResolvedValue(detail);
    api.compareHostSnapshots.mockResolvedValue(comparison);
    renderPane("later");
    await screen.findAllByText("before upgrade");
    await userEvent.selectOptions(screen.getByRole("combobox"), "earlier");
    expect(
      await screen.findByText(
        "Not comparable: in the later capture the subsystem was not present.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("3 changes, 1 section could not be compared", { exact: false }),
    ).toBeTruthy();
  });

  it("deletes the selected capture", async () => {
    api.listHostSnapshots.mockResolvedValue([
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
    ]);
    api.getHostSnapshot.mockResolvedValue(detail);
    api.deleteHostSnapshot.mockResolvedValue(undefined);
    renderPane();
    await screen.findAllByText("after upgrade");
    await userEvent.click(screen.getByRole("button", { name: "Delete snapshot" }));
    await waitFor(() => expect(api.deleteHostSnapshot).toHaveBeenCalledWith("later"));
  });

  it("surfaces a capture failure without inventing a snapshot", async () => {
    api.listHostSnapshots.mockResolvedValue([]);
    api.captureHostSnapshot.mockRejectedValue(new Error("Capture stopped before it finished"));
    renderPane(null);
    await screen.findByText("No snapshots yet");
    await userEvent.click(screen.getByRole("button", { name: /Capture snapshot/ }));
    expect(await screen.findByText("Capture stopped before it finished")).toBeTruthy();
  });
});
