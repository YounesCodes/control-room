// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listServices: vi.fn(),
  inspectSystemdRelationships: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type { CachedList, SavedConnection, SystemdUnit } from "../types";
import { ServicesPane } from "./ServicesPane";

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
    expect(screen.getByText(/not a complete host health check/i)).toBeTruthy();
  });

  it("opens a bounded typed relationship neighborhood and navigates to related units", async () => {
    const user = userEvent.setup();
    api.inspectSystemdRelationships.mockImplementation(async (_connectionId, root: string) => ({
      root,
      nodes: [
        {
          id: root,
          unitType: root.split(".").at(-1),
          description: `${root} description`,
          loadState: "loaded",
          activeState: "active",
          subState: "running",
        },
        {
          id: root === "web.service" ? "network.target" : "web.service",
          unitType: root === "web.service" ? "target" : "service",
          description: "Related unit",
          loadState: "loaded",
          activeState: "active",
          subState: "active",
        },
      ],
      edges: [
        {
          source: root,
          target: root === "web.service" ? "network.target" : "web.service",
          relationship: "after",
        },
      ],
      depthLimit: 1,
      nodeLimit: 40,
      edgeLimit: 240,
      truncated: false,
    }));

    render(
      <ServicesPane
        connection={connection}
        cache={cache([unit("web.service", "service", "active", "running")])}
        onCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Relationships" }));
    expect(await screen.findByLabelText("Relationships for web.service")).toBeTruthy();
    expect(screen.getByText("After")).toBeTruthy();
    expect(screen.getByText(/ordering only/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Inspect network.target" }));
    expect(api.inspectSystemdRelationships).toHaveBeenLastCalledWith(
      "connection-a",
      "network.target",
    );
    expect(await screen.findByRole("heading", { name: "network.target" })).toBeTruthy();
  });
});
