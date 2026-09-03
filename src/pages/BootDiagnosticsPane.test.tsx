// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ collectBootDiagnostics: vi.fn() }));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type { BootDiagnostics, SavedConnection } from "../types";
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

describe("BootDiagnosticsPane", () => {
  beforeEach(() => api.collectBootDiagnostics.mockResolvedValue(snapshot()));
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("collects current boot facts and routes a failed unit to its journal", async () => {
    const user = userEvent.setup();
    const onSnapshotChange = vi.fn();
    const onViewLogs = vi.fn();
    const { rerender } = render(
      <BootDiagnosticsPane
        connection={connection}
        snapshot={null}
        onSnapshotChange={onSnapshotChange}
        onViewLogs={onViewLogs}
      />,
    );
    await waitFor(() => expect(onSnapshotChange).toHaveBeenCalledWith(snapshot()));
    rerender(
      <BootDiagnosticsPane
        connection={connection}
        snapshot={snapshot()}
        onSnapshotChange={onSnapshotChange}
        onViewLogs={onViewLogs}
      />,
    );

    expect(screen.getByText("8.368s")).toBeTruthy();
    expect(screen.getByText(/duration alone does not establish cause/i)).toBeTruthy();
    expect(screen.getByText("warning: bounded evidence")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "View journal" }));
    expect(onViewLogs).toHaveBeenCalledWith({ type: "systemd", id: "backup.service" });
  });

  it("loads a selected previous boot and keeps current-only sections explicit", async () => {
    const user = userEvent.setup();
    const previousSnapshot = snapshot({
      selectedBootId: previousId,
      timing: {
        collectedAt,
        data: null,
        error: "Timing is available for the current boot only",
        permissionRequired: false,
      },
    });
    const onSnapshotChange = vi.fn();
    api.collectBootDiagnostics.mockResolvedValue(previousSnapshot);
    const { rerender } = render(
      <BootDiagnosticsPane
        connection={connection}
        snapshot={snapshot()}
        onSnapshotChange={onSnapshotChange}
        onViewLogs={vi.fn()}
      />,
    );
    const bootSelect = screen.getByLabelText("Boot") as HTMLSelectElement;
    await waitFor(() => expect(bootSelect.disabled).toBe(false));
    await user.selectOptions(bootSelect, previousId);

    await waitFor(() =>
      expect(api.collectBootDiagnostics).toHaveBeenLastCalledWith("connection-a", previousId, null),
    );
    expect(onSnapshotChange).toHaveBeenLastCalledWith(previousSnapshot);
    rerender(
      <BootDiagnosticsPane
        connection={connection}
        snapshot={previousSnapshot}
        onSnapshotChange={onSnapshotChange}
        onViewLogs={vi.fn()}
      />,
    );
    expect(screen.getByText("Timing is available for the current boot only")).toBeTruthy();
  });

  it("offers transient sudo retry only for a permission-limited boot journal", async () => {
    const user = userEvent.setup();
    const permissionSnapshot = snapshot({
      journal: {
        collectedAt,
        data: null,
        error: "Boot journal requires permission",
        permissionRequired: true,
      },
    });
    api.collectBootDiagnostics.mockResolvedValue(permissionSnapshot);
    render(
      <BootDiagnosticsPane
        connection={connection}
        snapshot={permissionSnapshot}
        onSnapshotChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Retry with sudo" }));
    const password = screen.getByText("Password").closest("label")?.querySelector("input");
    expect(password).toBeTruthy();
    await user.type(password!, "one-time-password");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(api.collectBootDiagnostics).toHaveBeenLastCalledWith(
        "connection-a",
        currentId,
        "one-time-password",
      ),
    );
  });
});
