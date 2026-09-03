// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listHostBaselines: vi.fn(),
  getHostBaseline: vi.fn(),
  captureHostBaseline: vi.fn(),
  cancelHostBaseline: vi.fn(),
  renameHostBaseline: vi.fn(),
  deleteHostBaseline: vi.fn(),
  compareHostBaselines: vi.fn(),
  compareHostBaselineWithLive: vi.fn(),
  setHostBaselinePinned: vi.fn(),
  traceHostBaselineEntry: vi.fn(),
  exportTextFile: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

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
  HostBaseline,
  HostBaselineSummary,
  SavedConnection,
  BaselineComparison,
} from "../types";
import { BaselinesPane } from "./BaselinesPane";

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

const identity = {
  hostname: "host-a",
  machineFingerprint: "0123456789abcdef",
  osId: "debian",
  osVersion: "13",
  kernel: "6.1.0",
  architecture: "x86_64",
};

function summary(
  id: string,
  capturedAt: string,
  label: string | null,
  extra: Partial<HostBaselineSummary> = {},
): HostBaselineSummary {
  return {
    id,
    connectionId: connection.id,
    label,
    schemaVersion: 1,
    capturedAt,
    pinned: false,
    changesSincePrevious: null,
    identity,
    ...extra,
    sections: [
      { kind: "host", status: "collected", entryCount: 1 },
      { kind: "systemdUnits", status: "collected", entryCount: 40 },
      { kind: "containers", status: "unsupported", entryCount: 0 },
      { kind: "listeners", status: "partial", entryCount: 7 },
      { kind: "filesystems", status: "collected", entryCount: 3 },
    ],
  };
}

const detail: HostBaseline = {
  id: "later",
  connectionId: connection.id,
  label: "after upgrade",
  schemaVersion: 1,
  capturedAt: "2026-09-02T10:00:00Z",
  pinned: false,
  identity,
  sections: [
    {
      kind: "host",
      status: "collected",
      schemaVersion: 1,
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
      kind: "systemdUnits",
      status: "collected",
      schemaVersion: 1,
      collectedAt: "2026-09-02T10:00:00Z",
      message: null,
      entries: [
        {
          identity: "ssh.service",
          label: "ssh.service",
          facts: [{ name: "activeState", value: "active" }],
        },
        {
          identity: "nginx.service",
          label: "nginx.service",
          facts: [{ name: "activeState", value: "failed" }],
        },
      ],
    },
    {
      kind: "containers",
      status: "unsupported",
      schemaVersion: 1,
      collectedAt: "2026-09-02T10:00:00Z",
      message: "Docker is not installed",
      entries: [],
    },
  ],
};

const comparison: BaselineComparison = {
  base: summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
  target: summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
  identityMatch: "same",
  schemaCompatible: true,
  targetIsLive: false,
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

// The section names now appear twice on the page: once as capture checkboxes,
// once in the detail. Detail assertions look inside the detail panel only.
function detail_panel() {
  return within(screen.getByRole("complementary"));
}

function renderPane(selectedId: string | null = "later") {
  const onSelect = vi.fn();
  render(<BaselinesPane connection={connection} selectedId={selectedId} onSelect={onSelect} />);
  return onSelect;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("baselines pane", () => {
  it("lists saved captures and says capture is manual", async () => {
    api.listHostBaselines.mockResolvedValue([
      summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
    ]);
    api.getHostBaseline.mockResolvedValue(detail);
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
    api.listHostBaselines.mockResolvedValue([summary("later", "2026-09-02T10:00:00Z", null)]);
    api.getHostBaseline.mockResolvedValue(detail);
    renderPane();
    await screen.findAllByText("Containers");
    expect(detail_panel().getByText("Not present")).toBeTruthy();
    expect(detail_panel().getByText("Docker is not installed")).toBeTruthy();
  });

  it("compares earlier to later whichever capture is selected", async () => {
    api.listHostBaselines.mockResolvedValue([
      summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
    ]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.compareHostBaselines.mockResolvedValue(comparison);
    renderPane("later");
    await screen.findAllByText("before upgrade");
    await userEvent.selectOptions(screen.getByRole("combobox"), "earlier");
    await waitFor(() => expect(api.compareHostBaselines).toHaveBeenCalledWith("earlier", "later"));
    expect(await screen.findByText("postgresql.service")).toBeTruthy();
    expect(screen.getByText("nginx.service")).toBeTruthy();
    expect(screen.getByText("ssh.service")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
  });

  it("reports a section it could not compare rather than calling it unchanged", async () => {
    api.listHostBaselines.mockResolvedValue([
      summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
    ]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.compareHostBaselines.mockResolvedValue(comparison);
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

  it("compares the selected capture against live machine state without saving a capture", async () => {
    api.listHostBaselines.mockResolvedValue([summary("later", "2026-09-02T10:00:00Z", null)]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.compareHostBaselineWithLive.mockResolvedValue({
      ...comparison,
      base: summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
      target: summary("live", "2026-09-03T09:00:00Z", null),
      targetIsLive: true,
    });
    renderPane("later");
    await screen.findAllByText("Host facts");

    await userEvent.selectOptions(screen.getByRole("combobox"), "live");

    await waitFor(() =>
      expect(api.compareHostBaselineWithLive).toHaveBeenCalledWith(
        "later",
        expect.any(String),
        expect.anything(),
      ),
    );
    expect(await screen.findByText(/after upgrade → Live state:/)).toBeTruthy();
    expect(screen.getByText(/This read was not saved/)).toBeTruthy();
    expect(api.captureHostBaseline).not.toHaveBeenCalled();
    expect(screen.getByText("postgresql.service")).toBeTruthy();
  });

  it("offers the live comparison even when no other capture exists", async () => {
    api.listHostBaselines.mockResolvedValue([summary("later", "2026-09-02T10:00:00Z", null)]);
    api.getHostBaseline.mockResolvedValue(detail);
    renderPane("later");
    await screen.findAllByText("Host facts");

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect([...select.options].map((option) => option.value).includes("live")).toBe(true);
  });

  it("shows host facts as collected without listing their values", async () => {
    api.listHostBaselines.mockResolvedValue([summary("later", "2026-09-02T10:00:00Z", null)]);
    api.getHostBaseline.mockResolvedValue(detail);
    renderPane("later");
    await screen.findAllByText("Host facts");

    expect(detail_panel().getAllByText("Collected")).not.toHaveLength(0);
    expect(detail_panel().queryByText("kernel")).toBeNull();
    expect(detail_panel().queryByText("6.1.0")).toBeNull();
  });

  it("opens a section to the entries it recorded", async () => {
    api.listHostBaselines.mockResolvedValue([summary("later", "2026-09-02T10:00:00Z", null)]);
    api.getHostBaseline.mockResolvedValue(detail);
    renderPane("later");
    await screen.findAllByText("Systemd units");

    expect(detail_panel().queryByText("ssh.service")).toBeNull();
    await userEvent.click(detail_panel().getByRole("button", { name: /Systemd units/ }));

    expect(detail_panel().getByText("ssh.service")).toBeTruthy();
    expect(detail_panel().getByText("nginx.service")).toBeTruthy();
    expect(detail_panel().getByText("failed")).toBeTruthy();
  });

  it("reads one entry across every stored capture", async () => {
    api.listHostBaselines.mockResolvedValue([summary("later", "2026-09-02T10:00:00Z", null)]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.traceHostBaselineEntry.mockResolvedValue({
      kind: "systemdUnits",
      identity: "ssh.service",
      label: "ssh.service",
      points: [
        {
          baselineId: "later",
          label: "after upgrade",
          capturedAt: "2026-09-02T10:00:00Z",
          sectionStatus: "collected",
          present: true,
          facts: [{ name: "activeState", value: "failed" }],
        },
        {
          baselineId: "earlier",
          label: "before upgrade",
          capturedAt: "2026-09-01T10:00:00Z",
          sectionStatus: "collected",
          present: false,
          facts: [],
        },
      ],
    });
    renderPane("later");
    await screen.findAllByText("Systemd units");
    await userEvent.click(detail_panel().getByRole("button", { name: /Systemd units/ }));

    await userEvent.click(detail_panel().getByRole("button", { name: "History of ssh.service" }));

    await waitFor(() =>
      expect(api.traceHostBaselineEntry).toHaveBeenCalledWith(
        "connection-a",
        "systemdUnits",
        "ssh.service",
      ),
    );
    expect(await detail_panel().findByText("Not present in this capture")).toBeTruthy();
  });

  it("pins a capture so retention cannot evict it", async () => {
    api.listHostBaselines.mockResolvedValue([summary("later", "2026-09-02T10:00:00Z", null)]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.setHostBaselinePinned.mockResolvedValue(
      summary("later", "2026-09-02T10:00:00Z", null, { pinned: true }),
    );
    renderPane("later");
    await screen.findAllByText("Host facts");

    await userEvent.click(screen.getByRole("button", { name: "Pin baseline" }));

    await waitFor(() => expect(api.setHostBaselinePinned).toHaveBeenCalledWith("later", true));
  });

  it("captures only the sections that stay ticked", async () => {
    api.listHostBaselines.mockResolvedValue([]);
    api.captureHostBaseline.mockResolvedValue(summary("new", "2026-09-03T10:00:00Z", null));
    renderPane(null);
    await screen.findByText("No baselines yet");

    await userEvent.click(screen.getByRole("checkbox", { name: "Containers" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Filesystems" }));
    await userEvent.click(screen.getByRole("button", { name: /Capture baseline/ }));

    await waitFor(() => expect(api.captureHostBaseline).toHaveBeenCalled());
    expect(api.captureHostBaseline.mock.calls[0][0].sections).toEqual([
      "host",
      "systemdUnits",
      "listeners",
    ]);
  });

  it("sends no section list when every section is wanted", async () => {
    api.listHostBaselines.mockResolvedValue([]);
    api.captureHostBaseline.mockResolvedValue(summary("new", "2026-09-03T10:00:00Z", null));
    renderPane(null);
    await screen.findByText("No baselines yet");

    await userEvent.click(screen.getByRole("button", { name: /Capture baseline/ }));

    await waitFor(() => expect(api.captureHostBaseline).toHaveBeenCalled());
    expect(api.captureHostBaseline.mock.calls[0][0].sections).toBeNull();
  });

  it("says how far each row moved from the capture below it", async () => {
    api.listHostBaselines.mockResolvedValue([
      summary("later", "2026-09-02T10:00:00Z", "after upgrade", { changesSincePrevious: 12 }),
      summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
    ]);
    api.getHostBaseline.mockResolvedValue(detail);
    renderPane("later");

    expect(await screen.findByText("12 changed")).toBeTruthy();
    expect(screen.getByText("3/5 collected")).toBeTruthy();
  });

  it("deletes the selected capture", async () => {
    api.listHostBaselines.mockResolvedValue([
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
    ]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.deleteHostBaseline.mockResolvedValue(undefined);
    renderPane();
    await screen.findAllByText("after upgrade");
    await userEvent.click(screen.getByRole("button", { name: "Delete baseline" }));
    await waitFor(() => expect(api.deleteHostBaseline).toHaveBeenCalledWith("later"));
  });

  it("surfaces a capture failure without inventing a baseline", async () => {
    api.listHostBaselines.mockResolvedValue([]);
    api.captureHostBaseline.mockRejectedValue(new Error("Capture stopped before it finished"));
    renderPane(null);
    await screen.findByText("No baselines yet");
    await userEvent.click(screen.getByRole("button", { name: /Capture baseline/ }));
    expect(await screen.findByText("Capture stopped before it finished")).toBeTruthy();
  });
});
