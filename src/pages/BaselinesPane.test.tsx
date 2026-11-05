// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  getHostBaselineReference: vi.fn(),
  setHostBaselineReference: vi.fn(),
  clearHostBaselineReference: vi.fn(),
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
    schemaVersion: 2,
    capturedAt,
    pinned: false,
    changesSincePrevious: null,
    routineSincePrevious: null,
    identity,
    ...extra,
    sections: [
      { kind: "host", status: "collected", entryCount: 1 },
      { kind: "systemdUnits", status: "collected", entryCount: 40 },
      { kind: "containers", status: "unsupported", entryCount: 0 },
      { kind: "listeners", status: "partial", entryCount: 7 },
      { kind: "firewall", status: "collected", entryCount: 3 },
      { kind: "filesystems", status: "collected", entryCount: 3 },
      { kind: "scheduledJobs", status: "collected", entryCount: 4 },
      { kind: "packages", status: "partial", entryCount: 5000 },
    ],
  };
}

const detail: HostBaseline = {
  id: "later",
  connectionId: connection.id,
  label: "after upgrade",
  schemaVersion: 2,
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
          facts: [
            { name: "activeState", value: "failed" },
            { name: "subState", value: "running" },
          ],
        },
        {
          identity: "nginx.service",
          label: "nginx.service",
          facts: [{ name: "activeState", value: "active" }],
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

function comparisonFixture(): BaselineComparison {
  return {
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
            changes: [
              {
                name: "activeState",
                baseValue: "active",
                targetValue: "failed",
                classification: "meaningful",
                reason: null,
              },
              {
                name: "subState",
                baseValue: "running",
                targetValue: "dead",
                classification: "routine",
                reason: "Sub-states move on their own between captures.",
              },
            ],
          },
        ],
        unchangedCount: 37,
        routineCount: 1,
        removalsIndeterminate: false,
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
        routineCount: 0,
        removalsIndeterminate: false,
      },
    ],
  };
}

function inspector_pane() {
  return within(screen.getByRole("complementary"));
}

function renderPane(selectedId: string | null = "later", extraProps: Record<string, unknown> = {}) {
  const onSelect = vi.fn();
  render(
    <BaselinesPane
      connection={connection}
      selectedId={selectedId}
      onSelect={onSelect}
      globalSudoEnabled={false}
      {...extraProps}
    />,
  );
  return onSelect;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("baselines explorer", () => {
  it("opens with the latest capture selected and compares it with the previous one", async () => {
    api.listHostBaselines.mockResolvedValue([
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
      summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
    ]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.compareHostBaselines.mockResolvedValue(comparisonFixture());
    api.getHostBaselineReference.mockResolvedValue(null);
    renderPane("later");
    expect(await screen.findAllByText("after upgrade")).not.toHaveLength(0);
    // The comparison against the previous capture runs on its own: opening the
    // pane answers "what changed", without asking the host anything.
    await waitFor(() => expect(api.compareHostBaselines).toHaveBeenCalledWith("earlier", "later"));
    // Nothing contacted the host to draw the timeline.
    expect(api.captureHostBaseline).not.toHaveBeenCalled();
    expect(api.compareHostBaselineWithLive).not.toHaveBeenCalled();
  });

  it("navigates the timeline with the keyboard and updates the selection", async () => {
    api.listHostBaselines.mockResolvedValue([
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
      summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
    ]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.getHostBaselineReference.mockResolvedValue(null);
    const onSelect = renderPane("later");
    await screen.findAllByText("after upgrade");
    const timeline = screen.getByRole("group", { name: "Capture history" });
    timeline.focus();
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("earlier"));
    await userEvent.keyboard("{Home}");
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("earlier"));
    await userEvent.keyboard("{End}");
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("later"));
    await userEvent.click(screen.getByRole("button", { name: "Jump to latest capture" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("later"));
  });

  it("shows distinct honest states instead of a false all-clear", async () => {
    api.listHostBaselines.mockResolvedValue([summary("later", "2026-09-02T10:00:00Z", null)]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.getHostBaselineReference.mockResolvedValue(null);
    renderPane("later");
    await screen.findByText(/No earlier capture/);
    expect(screen.getByRole("tab", { name: "State" }).getAttribute("aria-selected")).toBe("true");
  });

  it("defaults a single capture to State and searches recorded facts", async () => {
    api.listHostBaselines.mockResolvedValue([
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
    ]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.getHostBaselineReference.mockResolvedValue(null);
    renderPane();
    await screen.findByRole("tab", { name: "State" });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "State" }).getAttribute("aria-selected")).toBe("true"),
    );
    await userEvent.type(screen.getByRole("textbox", { name: "Search baseline" }), "failed");
    expect(await screen.findByRole("button", { name: "ssh.service" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "nginx.service" })).toBeNull();
  });

  it("does not read the live host again when navigating saved history", async () => {
    api.listHostBaselines.mockResolvedValue([
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
      summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
    ]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.getHostBaselineReference.mockResolvedValue(null);
    api.compareHostBaselines.mockResolvedValue(comparisonFixture());
    api.compareHostBaselineWithLive.mockResolvedValue({
      ...comparisonFixture(),
      targetIsLive: true,
    });
    const view = render(
      <BaselinesPane
        connection={connection}
        selectedId="later"
        onSelect={vi.fn()}
        globalSudoEnabled={false}
      />,
    );
    await screen.findByRole("combobox", { name: "Compare with" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Compare with" }), "live");
    await waitFor(() => expect(api.compareHostBaselineWithLive).toHaveBeenCalledTimes(1));
    view.rerender(
      <BaselinesPane
        connection={connection}
        selectedId="earlier"
        onSelect={vi.fn()}
        globalSudoEnabled={false}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Compare with" })).toHaveProperty(
        "value",
        "previous",
      ),
    );
    expect(api.compareHostBaselineWithLive).toHaveBeenCalledTimes(1);
  });

  it("captures from a dialog, defaults to every section and reports real progress", async () => {
    api.listHostBaselines.mockResolvedValue([]);
    api.getHostBaselineReference.mockResolvedValue(null);
    let finish!: (value: HostBaselineSummary) => void;
    api.captureHostBaseline.mockImplementationOnce((request, channel) => {
      channel.onmessage({
        captureId: request.captureId,
        kind: "host",
        status: "collected",
        message: null,
        completed: 1,
        total: 8,
      });
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    api.cancelHostBaseline.mockResolvedValue(undefined);
    renderPane(null);
    await screen.findByText("No captures yet");
    await userEvent.click(screen.getByRole("button", { name: /Capture baseline/ }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Ports" }));
    await userEvent.click(within(dialog).getByRole("button", { name: /Start capture/ }));
    await screen.findByText("Host facts");
    expect(within(dialog).getByText("Collected")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Stop after this section" }));
    expect(api.cancelHostBaseline).toHaveBeenCalledExactlyOnceWith(
      api.captureHostBaseline.mock.calls[0][0].captureId,
    );
    await act(async () => finish(summary("new", "2026-09-03T10:00:00Z", "fresh capture")));
    const request = api.captureHostBaseline.mock.calls[0][0];
    expect(request.label).toBeNull();
    expect(request.sections).toEqual([
      "host",
      "systemdUnits",
      "containers",
      "firewall",
      "filesystems",
      "scheduledJobs",
      "packages",
      "configurationAccess",
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sends a label and no section list when everything stays selected", async () => {
    api.listHostBaselines.mockResolvedValue([]);
    api.getHostBaselineReference.mockResolvedValue(null);
    api.captureHostBaseline.mockResolvedValue(summary("new", "2026-09-03T10:00:00Z", null));
    renderPane(null);
    await screen.findByText("No captures yet");
    await userEvent.click(screen.getByRole("button", { name: /Capture baseline/ }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Baseline label" }), "after");
    await userEvent.click(within(dialog).getByRole("button", { name: /Start capture/ }));
    await waitFor(() => expect(api.captureHostBaseline).toHaveBeenCalled());
    expect(api.captureHostBaseline.mock.calls[0][0].label).toBe("after");
    expect(api.captureHostBaseline.mock.calls[0][0].sections).toBeNull();
  });

  it("compares against the reference capture when one is marked", async () => {
    api.listHostBaselines.mockResolvedValue([
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
      summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
      summary("reference", "2026-09-01T08:00:00Z", "clean install"),
    ]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.compareHostBaselines.mockResolvedValue(comparisonFixture());
    api.getHostBaselineReference.mockResolvedValue(
      summary("reference", "2026-09-01T08:00:00Z", "clean install"),
    );
    renderPane("later");
    await screen.findAllByText("after upgrade");
    await userEvent.click(screen.getByRole("button", { name: "Mark as reference" }));
    expect(api.setHostBaselineReference).not.toHaveBeenCalled();
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Replace reference" }),
    );
    await waitFor(() => expect(api.setHostBaselineReference).toHaveBeenCalledWith("later"));
    const options = screen.getByRole("combobox", { name: "Compare with" });
    await userEvent.selectOptions(options, "reference");
    await waitFor(() =>
      expect(api.compareHostBaselines).toHaveBeenCalledWith("reference", "later"),
    );
  });

  it("clears the reference only after an explicit confirmation", async () => {
    api.listHostBaselines.mockResolvedValue([
      summary("reference", "2026-09-01T08:00:00Z", "clean install"),
    ]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.getHostBaselineReference.mockResolvedValue(
      summary("reference", "2026-09-01T08:00:00Z", "clean install"),
    );
    api.clearHostBaselineReference.mockResolvedValue(true);
    renderPane("reference");
    await screen.findAllByText("clean install");
    await userEvent.click(screen.getByRole("button", { name: "Clear reference" }));
    expect(api.clearHostBaselineReference).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("dialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "Clear reference" }));
    await waitFor(() =>
      expect(api.clearHostBaselineReference).toHaveBeenCalledWith("connection-a"),
    );
  });

  it("deletes the selected capture after a confirmation that warns about the reference", async () => {
    api.listHostBaselines.mockResolvedValue([
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
    ]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.getHostBaselineReference.mockResolvedValue(
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
    );
    api.deleteHostBaseline.mockResolvedValue(undefined);
    renderPane("later");
    await screen.findAllByText("after upgrade");
    await userEvent.click(screen.getByRole("button", { name: "Delete capture" }));
    expect(api.deleteHostBaseline).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/clears with it/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete capture" }));
    await waitFor(() => expect(api.deleteHostBaseline).toHaveBeenCalledWith("later"));
  });

  it("pins and renames the selected capture", async () => {
    api.listHostBaselines.mockResolvedValue([summary("later", "2026-09-02T10:00:00Z", null)]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.getHostBaselineReference.mockResolvedValue(null);
    api.setHostBaselinePinned.mockResolvedValue(
      summary("later", "2026-09-02T10:00:00Z", null, { pinned: true }),
    );
    api.renameHostBaseline.mockResolvedValue(summary("later", "2026-09-02T10:00:00Z", "renamed"));
    renderPane("later");
    await screen.findByRole("tab", { name: "Changes" });
    await userEvent.click(screen.getByRole("button", { name: "Pin capture" }));
    await waitFor(() => expect(api.setHostBaselinePinned).toHaveBeenCalledWith("later", true));
    await userEvent.click(screen.getByRole("button", { name: "Rename capture" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Capture label" }), "renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.renameHostBaseline).toHaveBeenCalledWith("later", "renamed"));
  });

  it("compares the selected capture with an unsaved live read", async () => {
    api.listHostBaselines.mockResolvedValue([summary("later", "2026-09-02T10:00:00Z", null)]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.getHostBaselineReference.mockResolvedValue(null);
    api.compareHostBaselineWithLive.mockResolvedValue({
      ...comparisonFixture(),
      base: summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
      target: summary("live", "2026-09-03T09:00:00Z", null),
      targetIsLive: true,
    });
    renderPane("later");
    await screen.findByRole("tab", { name: "Changes" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Compare with" }), "live");
    await waitFor(() =>
      expect(api.compareHostBaselineWithLive).toHaveBeenCalledWith(
        "later",
        expect.any(String),
        expect.anything(),
        connection.id,
        null,
      ),
    );
    expect(await screen.findByText(/This read was not saved/)).toBeTruthy();
    expect(api.captureHostBaseline).not.toHaveBeenCalled();
    expect(screen.getByText("postgresql.service")).toBeTruthy();
  });

  it("ignores a comparison that finishes after a newer selection", async () => {
    api.listHostBaselines.mockResolvedValue([
      summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
    ]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.getHostBaselineReference.mockResolvedValue(null);
    let finish!: (value: BaselineComparison) => void;
    api.compareHostBaselines.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onSelect = vi.fn();
    const view = render(
      <BaselinesPane
        connection={connection}
        selectedId="later"
        onSelect={onSelect}
        globalSudoEnabled={false}
      />,
    );
    await waitFor(() => expect(api.compareHostBaselines).toHaveBeenCalled());
    view.rerender(
      <BaselinesPane
        connection={connection}
        selectedId="earlier"
        onSelect={onSelect}
        globalSudoEnabled={false}
      />,
    );
    await act(async () => finish(comparisonFixture()));
    expect(screen.queryByText("postgresql.service")).toBeNull();
    expect(screen.queryByText("Comparing captures…")).toBeNull();
  });

  it("shows the state view and opens the inspector with history across captures", async () => {
    api.listHostBaselines.mockResolvedValue([summary("later", "2026-09-02T10:00:00Z", null)]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.getHostBaselineReference.mockResolvedValue(null);
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
      ],
    });
    const onOpenSystemd = vi.fn();
    renderPane("later", { onOpenSystemd });
    await screen.findByRole("tab", { name: "Changes" });
    await userEvent.click(screen.getByRole("tab", { name: "State" }));
    await userEvent.click(screen.getByRole("button", { name: /Systemd units/ }));
    await userEvent.click(screen.getByRole("button", { name: "ssh.service" }));
    const pane = inspector_pane();
    expect(pane.getAllByText("failed")).not.toHaveLength(0);
    await userEvent.click(pane.getByRole("button", { name: /Read across captures/ }));
    await waitFor(() =>
      expect(api.traceHostBaselineEntry).toHaveBeenCalledWith(
        "connection-a",
        "systemdUnits",
        "ssh.service",
      ),
    );
    await userEvent.click(pane.getByRole("button", { name: "Open in Systemd" }));
    expect(onOpenSystemd).toHaveBeenCalledWith("ssh.service");
    await userEvent.click(pane.getByRole("button", { name: "Close inspector" }));
    expect(screen.getByRole("button", { name: "ssh.service" })).toBeTruthy();
  });

  it("opens a changed row in the inspector with exact before and after facts", async () => {
    api.listHostBaselines.mockResolvedValue([
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
      summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
    ]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.getHostBaselineReference.mockResolvedValue(null);
    api.compareHostBaselines.mockResolvedValue(comparisonFixture());
    renderPane("later");
    await screen.findByText("ssh.service");
    await userEvent.click(screen.getByRole("button", { name: /ssh\.service/ }));
    const pane = inspector_pane();
    expect(pane.getAllByText("activeState")).not.toHaveLength(0);
    expect(pane.getByText("active")).toBeTruthy();
    expect(pane.getAllByText("failed")).not.toHaveLength(0);
    expect(pane.getByText("Sub-states move on their own between captures.")).toBeTruthy();
  });

  it("reveals a Docker deep link only when the capture recorded the container ID", async () => {
    api.listHostBaselines.mockResolvedValue([summary("later", "2026-09-02T10:00:00Z", null)]);
    const withContainer: HostBaseline = {
      ...detail,
      sections: [
        ...detail.sections,
        {
          kind: "containers",
          status: "collected",
          schemaVersion: 1,
          collectedAt: "2026-09-02T10:00:00Z",
          message: null,
          entries: [
            {
              identity: "api",
              label: "api",
              facts: [
                { name: "image", value: "api:2" },
                { name: "containerId", value: "abc123" },
              ],
            },
          ],
        },
      ],
    };
    api.getHostBaseline.mockResolvedValue(withContainer);
    api.getHostBaselineReference.mockResolvedValue(null);
    const onOpenContainer = vi.fn();
    renderPane("later", { onOpenContainer });
    await screen.findByRole("tab", { name: "Changes" });
    await userEvent.click(screen.getByRole("tab", { name: "State" }));
    await userEvent.click(screen.getByRole("button", { name: /Containers/ }));
    await userEvent.click(screen.getByRole("button", { name: "api" }));
    await userEvent.click(inspector_pane().getByRole("button", { name: "Open in Docker" }));
    expect(onOpenContainer).toHaveBeenCalledWith("abc123");
  });

  it("offers a one-shot sudo retry without changing the saved permission", async () => {
    api.listHostBaselines.mockResolvedValue([]);
    api.getHostBaselineReference.mockResolvedValue(null);
    let finish!: (value: HostBaselineSummary) => void;
    api.captureHostBaseline.mockImplementationOnce((request, channel) => {
      channel.onmessage({
        captureId: request.captureId,
        kind: "containers",
        status: "unavailable",
        message: "permission denied",
        completed: 3,
        total: 8,
      });
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    renderPane(null, { globalSudoEnabled: false });
    await screen.findByText("No captures yet");
    await userEvent.click(screen.getByRole("button", { name: /Capture baseline/ }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /Start capture/ }),
    );
    await act(async () => finish(summary("partial", "2026-09-04T10:00:00Z", "with gap")));
    await screen.findByText(/Some sections were incomplete or could not be read/);
    expect(screen.getByRole("button", { name: "Retry with sudo" })).toBeTruthy();
  });

  it("pins the capture count and manual-collection honesty to the header", async () => {
    api.listHostBaselines.mockResolvedValue([
      summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
      summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
    ]);
    api.getHostBaseline.mockResolvedValue(detail);
    api.getHostBaselineReference.mockResolvedValue(null);
    renderPane("later");
    expect(await screen.findByText(/2 captures/)).toBeTruthy();
    expect(
      screen.getByTitle("Capture now. Control Room never collects in the background."),
    ).toBeTruthy();
  });

  it("surfaces a capture failure without inventing a baseline", async () => {
    api.listHostBaselines.mockResolvedValue([]);
    api.getHostBaselineReference.mockResolvedValue(null);
    api.captureHostBaseline.mockRejectedValue(new Error("Capture stopped before it finished"));
    renderPane(null);
    await screen.findByText("No captures yet");
    await userEvent.click(screen.getByRole("button", { name: /Capture baseline/ }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /Start capture/ }),
    );
    expect(await screen.findByText("Capture stopped before it finished")).toBeTruthy();
  });
});
