// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listServices: vi.fn(),
  inspectSystemdUnit: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type { CachedList, SavedConnection, SystemdUnit } from "../types";
import { ServicesPane } from "./ServicesPane";
import { invalidateSystemdReads } from "../lib/systemd-inspection";
import { systemdInspection } from "../test/systemd-fixtures";

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

function unit(id: string, unitType: string, activeState: string, subState: string): SystemdUnit {
  return {
    id,
    unitType,
    description: `${id} description`,
    loadState: "loaded",
    activeState,
    subState,
    unitFileState: "enabled",
  };
}

function cache(items: SystemdUnit[]): CachedList<SystemdUnit> {
  return {
    items,
    fetchedAt: Date.now(),
    loading: false,
    error: null,
  };
}

describe("ServicesPane failed units view", () => {
  afterEach(cleanup);
  beforeEach(() => {
    invalidateSystemdReads(connection.id);
    api.inspectSystemdUnit
      .mockReset()
      .mockImplementation((_connection, id) => Promise.resolve(systemdInspection(id)));
  });

  it("shows counts, filters across types, and opens the selected unit journal", async () => {
    const user = userEvent.setup();
    const onViewLogs = vi.fn();
    render(
      <ServicesPane
        connection={connection}
        cache={cache([
          unit("web.service", "service", "active", "running"),
          unit("backup.timer", "timer", "failed", "failed"),
          unit("data.mount", "mount", "failed", "failed"),
          unit("api.socket", "socket", "active", "listening"),
        ])}
        onCacheChange={vi.fn()}
        onViewLogs={onViewLogs}
      />,
    );

    expect(screen.getByRole("heading", { name: "Systemd" })).toBeTruthy();
    expect(screen.getByText(/2 active/)).toBeTruthy();
    expect(screen.getByText(/2 failed/)).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Unit state"), "failed");
    await user.selectOptions(screen.getByLabelText("Unit type"), "timer");
    expect(screen.getByRole("button", { name: /backup.timer/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /data.mount/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /backup.timer/i }));
    await user.click(screen.getByRole("button", { name: "View journal" }));
    expect(onViewLogs).toHaveBeenCalledWith({ type: "systemd", id: "backup.timer" });
  });

  it("describes zero failures as a scoped current result", () => {
    render(
      <ServicesPane
        connection={connection}
        cache={cache([unit("web.service", "service", "active", "running")])}
        onCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );

    expect(screen.getByText(/0 failed/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Systemd" }).title).toContain(
      "not a complete host health check",
    );
  });

  it("does not leave details visible when filters hide the selected unit", async () => {
    const user = userEvent.setup();
    render(
      <ServicesPane
        connection={connection}
        cache={cache([
          unit("data.mount", "mount", "active", "mounted"),
          unit("ssh.service", "service", "active", "running"),
        ])}
        onCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "data.mount" })).toBeTruthy();
    await user.type(screen.getByPlaceholderText("Search units"), "ssh");

    expect(screen.queryByRole("heading", { name: "data.mount" })).toBeNull();
    expect(screen.getByText("Selected unit is outside this filter")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show selected unit" }));
    expect(screen.getByRole("heading", { name: "data.mount" })).toBeTruthy();
  });

  it("preserves selection across refreshes and reports missing detail evidence", async () => {
    const user = userEvent.setup();
    const items = [
      unit("a.service", "service", "active", "running"),
      unit("b.service", "service", "inactive", "dead"),
    ];
    api.listServices.mockResolvedValue([items[0]]);
    api.inspectSystemdUnit.mockRejectedValue(new Error("Unit no longer exists"));
    const onSelectionChange = vi.fn();
    const onCacheChange = vi.fn();
    render(
      <ServicesPane
        connection={connection}
        cache={cache(items)}
        onCacheChange={onCacheChange}
        onSelectionChange={onSelectionChange}
        onViewLogs={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /b.service description/ }));
    await user.click(screen.getByRole("button", { name: "Refresh systemd units" }));
    await waitFor(() =>
      expect(onCacheChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ items: [items[0]], loading: false }),
      ),
    );
    expect(screen.getByRole("heading", { name: "b.service" })).toBeTruthy();
    expect(onSelectionChange).toHaveBeenLastCalledWith("b.service");
    expect(await screen.findByText(/Unit no longer exists/)).toBeTruthy();
  });

  it("starts the graph at a newly selected inventory unit after a previous graph visit", async () => {
    const user = userEvent.setup();
    render(
      <ServicesPane
        connection={connection}
        cache={cache([
          unit("a.service", "service", "active", "running"),
          unit("b.service", "service", "active", "running"),
        ])}
        onCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Dependency graph" }));
    expect(screen.getByTitle("Refocus on current unit").textContent).toBe("a.service");
    await user.click(screen.getByRole("button", { name: "Unit inventory" }));
    await user.click(screen.getByRole("button", { name: /b.service description/ }));
    await user.click(screen.getByRole("button", { name: "Dependency graph" }));
    expect(screen.getByTitle("Refocus on current unit").textContent).toBe("b.service");
  });

  it("expands only requested neighbors and refocuses graph navigation", async () => {
    const user = userEvent.setup();
    api.inspectSystemdUnit.mockImplementation((_connection, id) =>
      Promise.resolve(
        systemdInspection(
          id,
          id === "a.service"
            ? { Requires: "b.service", After: "b.service" }
            : { Wants: "c.service" },
        ),
      ),
    );
    render(
      <ServicesPane
        connection={connection}
        cache={cache([unit("a.service", "service", "active", "running")])}
        onCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Dependency graph" }));
    const graph = screen.getByRole("region", { name: "Systemd dependency graph" });
    expect(await within(graph).findByRole("button", { name: /^b.service/ })).toBeTruthy();
    expect(api.inspectSystemdUnit).not.toHaveBeenCalledWith(
      connection.id,
      "b.service",
      "properties",
    );
    expect(within(graph).queryByRole("button", { name: /^c.service/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand b.service" }));
    expect(await within(graph).findByRole("button", { name: /^c.service/ })).toBeTruthy();
    await user.dblClick(within(graph).getByRole("button", { name: /^b.service/ }));
    expect(screen.getByTitle("Refocus on current unit").textContent).toBe("b.service");
    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("complementary", { name: "Unit details" })).toBeNull();
  });
});
