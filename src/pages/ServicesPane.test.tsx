// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listServices: vi.fn(),
  inspectSystemdUnit: vi.fn(),
  listPorts: vi.fn(),
  collectBootDiagnostics: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type {
  BootDiagnostics,
  CachedList,
  ListeningSocket,
  SavedConnection,
  SystemdUnit,
} from "../types";
import { bootDiagnostics } from "../test/boot-fixtures";
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

function cache<T>(items: T[]): CachedList<T> {
  return {
    items,
    fetchedAt: Date.now(),
    loading: false,
    error: null,
  };
}

describe("ServicesPane failed units view", () => {
  it("updates memory while the service inspector is open and stops after closing it", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      api.inspectSystemdUnit.mockResolvedValue(
        systemdInspection("worker.service", { MemoryCurrent: "1048576" }),
      );
      render(
        <ServicesPane
          connection={connection}
          cache={cache([unit("worker.service", "service", "active", "running")])}
          onCacheChange={vi.fn()}
          onViewLogs={vi.fn()}
        />,
      );
      const row = screen.getByRole("button", { name: /worker.service description/ });
      fireEvent.click(row);
      await act(async () => {});
      expect(screen.getByText("1 MiB")).toBeTruthy();
      api.inspectSystemdUnit.mockResolvedValue(
        systemdInspection("worker.service", { MemoryCurrent: "2097152" }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByText("2 MiB")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close details" }));
      const count = api.inspectSystemdUnit.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(api.inspectSystemdUnit).toHaveBeenCalledTimes(count);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
  it.each(["slow", "failed", "unrelated", "historical"])(
    "gates Boot using current unit evidence: %s",
    async (kind) => {
      const user = userEvent.setup();
      const snapshot = bootDiagnostics();
      if (kind === "failed")
        snapshot.failedUnits.data = [unit("worker.service", "service", "failed", "failed")];
      else
        snapshot.slowUnits.data = [
          { unit: kind === "unrelated" ? "other.service" : "worker.service", duration: "2s" },
        ];
      if (kind === "historical") snapshot.selectedBootId = "b".repeat(32);
      const onOpenBoot = vi.fn();
      render(
        <ServicesPane
          connection={connection}
          cache={cache([unit("worker.service", "service", "active", "running")])}
          bootSnapshot={snapshot}
          onCacheChange={vi.fn()}
          onViewLogs={vi.fn()}
          onOpenBoot={onOpenBoot}
        />,
      );
      await user.click(screen.getByRole("button", { name: /worker.service description/ }));
      await user.click(screen.getByText("Advanced", { selector: "summary" }));
      const visible = kind === "slow" || kind === "failed";
      expect(!!screen.queryByRole("button", { name: "Boot" })).toBe(visible);
      if (visible) {
        await user.click(screen.getByRole("button", { name: "Boot" }));
        expect(onOpenBoot).toHaveBeenCalledTimes(1);
      }
      expect(api.collectBootDiagnostics).not.toHaveBeenCalled();
    },
  );
  it("collects boot evidence lazily, reuses the snapshot, and removes Boot when refreshed evidence no longer matches", async () => {
    const user = userEvent.setup();
    const snapshot = bootDiagnostics();
    snapshot.slowUnits.data = [{ unit: "worker.service", duration: "2s" }];
    api.collectBootDiagnostics
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(bootDiagnostics());
    const updates = vi.fn();
    function Pane() {
      const [bootSnapshot, setBootSnapshot] = useState<BootDiagnostics | null>(null);
      return (
        <ServicesPane
          connection={connection}
          cache={cache([unit("worker.service", "service", "active", "running")])}
          bootSnapshot={bootSnapshot}
          onBootSnapshotChange={(next) => {
            updates(next);
            setBootSnapshot(next);
          }}
          onCacheChange={vi.fn()}
          onViewLogs={vi.fn()}
          onOpenBoot={vi.fn()}
        />
      );
    }
    render(<Pane />);
    await user.click(screen.getByRole("button", { name: /worker.service description/ }));
    expect(api.collectBootDiagnostics).not.toHaveBeenCalled();
    await user.click(screen.getByText("Advanced", { selector: "summary" }));
    expect(await screen.findByRole("button", { name: "Boot" })).toBeTruthy();
    expect(api.collectBootDiagnostics).toHaveBeenCalledWith(connection.id, null, null);
    await user.click(screen.getByText("Advanced", { selector: "summary" }));
    await user.click(screen.getByText("Advanced", { selector: "summary" }));
    expect(api.collectBootDiagnostics).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Refresh unit details" }));
    await waitFor(() => expect(updates).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Boot" })).toBeNull();
  });
  it("hides Boot on a failed collection and retries on unit refresh", async () => {
    const user = userEvent.setup();
    api.collectBootDiagnostics.mockRejectedValueOnce(new Error("Boot unavailable"));
    function Pane() {
      const [bootSnapshot, setBootSnapshot] = useState<BootDiagnostics | null>(null);
      return (
        <ServicesPane
          connection={connection}
          cache={cache([unit("worker.service", "service", "active", "running")])}
          bootSnapshot={bootSnapshot}
          onBootSnapshotChange={setBootSnapshot}
          onCacheChange={vi.fn()}
          onViewLogs={vi.fn()}
          onOpenBoot={vi.fn()}
        />
      );
    }
    render(<Pane />);
    await user.click(screen.getByRole("button", { name: /worker.service description/ }));
    await user.click(screen.getByText("Advanced", { selector: "summary" }));
    await waitFor(() => expect(api.collectBootDiagnostics).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Boot" })).toBeNull();
    const next = bootDiagnostics();
    next.slowUnits.data = [{ unit: "worker.service", duration: "2s" }];
    api.collectBootDiagnostics.mockResolvedValueOnce(next);
    await user.click(screen.getByRole("button", { name: "Refresh unit details" }));
    expect(await screen.findByRole("button", { name: "Boot" })).toBeTruthy();
  });
  it("discards boot evidence after the SSH target changes and changes back", async () => {
    const user = userEvent.setup();
    let resolve!: (snapshot: BootDiagnostics) => void;
    api.collectBootDiagnostics.mockImplementation(
      () =>
        new Promise<BootDiagnostics>((done) => {
          resolve = done;
        }),
    );
    const onBootSnapshotChange = vi.fn();
    const props = {
      cache: cache([unit("worker.service", "service", "active", "running")]),
      bootSnapshot: null,
      onBootSnapshotChange,
      onCacheChange: vi.fn(),
      onViewLogs: vi.fn(),
      onOpenBoot: vi.fn(),
    };
    const view = render(<ServicesPane {...props} connection={connection} />);
    await user.click(screen.getByRole("button", { name: /worker.service description/ }));
    await user.click(screen.getByText("Advanced", { selector: "summary" }));
    await waitFor(() => expect(api.collectBootDiagnostics).toHaveBeenCalledTimes(1));
    view.rerender(
      <ServicesPane {...props} connection={{ ...connection, destination: "another-host" }} />,
    );
    view.rerender(<ServicesPane {...props} connection={connection} />);
    const old = bootDiagnostics();
    old.slowUnits.data = [{ unit: "worker.service", duration: "2s" }];
    await act(async () => {
      resolve(old);
    });
    expect(onBootSnapshotChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Boot" })).toBeNull();
  });

  const listener: ListeningSocket = {
    id: "tcp:8080",
    protocol: "tcp",
    addressFamily: "ipv4",
    localAddress: "0.0.0.0",
    port: 8080,
    processId: 42,
    processName: "worker",
    systemdUnit: "worker.service",
    ownership: "known",
  };

  it.each([
    ["worker.service", "known", true],
    ["another.service", "known", false],
    [null, "unavailable", false],
    ["worker.service", "ambiguous", false],
  ] as const)(
    "shows Ports only for a confirmed matching listener: %s / %s",
    async (systemdUnit, ownership, visible) => {
      const user = userEvent.setup();
      const onOpenPorts = vi.fn();
      render(
        <ServicesPane
          connection={connection}
          cache={cache([unit("worker.service", "service", "active", "running")])}
          portsCache={cache([{ ...listener, systemdUnit, ownership }])}
          onCacheChange={vi.fn()}
          onViewLogs={vi.fn()}
          onOpenPorts={onOpenPorts}
        />,
      );
      await user.click(screen.getByRole("button", { name: /worker.service description/ }));
      await user.click(screen.getByText("Advanced", { selector: "summary" }));
      expect(!!screen.queryByRole("button", { name: "Ports" })).toBe(visible);
      if (visible) {
        await user.click(screen.getByRole("button", { name: "Ports" }));
        expect(onOpenPorts).toHaveBeenCalledWith("worker.service");
      }
      expect(api.listPorts).not.toHaveBeenCalled();
    },
  );

  it("reads listeners only when Advanced opens, shares the cache, and removes Ports after a refresh finds none", async () => {
    const user = userEvent.setup();
    const updates = vi.fn();
    api.listPorts.mockResolvedValueOnce([listener]).mockResolvedValueOnce([]);
    function Pane() {
      const [portsCache, setPortsCache] = useState<CachedList<ListeningSocket>>({
        items: [],
        fetchedAt: null,
        loading: false,
        error: null,
      });
      return (
        <ServicesPane
          connection={connection}
          cache={cache([unit("worker.service", "service", "active", "running")])}
          portsCache={portsCache}
          onPortsCacheChange={(next) => {
            updates(next);
            setPortsCache(next);
          }}
          onCacheChange={vi.fn()}
          onViewLogs={vi.fn()}
          onOpenPorts={vi.fn()}
        />
      );
    }
    render(<Pane />);
    await user.click(screen.getByRole("button", { name: /worker.service description/ }));
    expect(api.listPorts).not.toHaveBeenCalled();
    await user.click(screen.getByText("Advanced", { selector: "summary" }));
    expect(await screen.findByRole("button", { name: "Ports" })).toBeTruthy();
    expect(api.listPorts).toHaveBeenCalledWith(connection.id);
    await user.click(screen.getByRole("button", { name: "Refresh unit details" }));
    await waitFor(() => expect(api.listPorts).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(updates).toHaveBeenLastCalledWith(
        expect.objectContaining({ items: [], loading: false, error: null }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Ports" })).toBeNull());
  });

  it("discards a listener read after the SSH target changes, including changing back", async () => {
    const user = userEvent.setup();
    let resolve!: (items: ListeningSocket[]) => void;
    api.listPorts.mockImplementation(
      () =>
        new Promise<ListeningSocket[]>((done) => {
          resolve = done;
        }),
    );
    const onPortsCacheChange = vi.fn();
    const props = {
      cache: cache([unit("worker.service", "service", "active", "running")]),
      portsCache: {
        items: [],
        fetchedAt: null,
        loading: false,
        error: null,
      } as CachedList<ListeningSocket>,
      onPortsCacheChange,
      onCacheChange: vi.fn(),
      onViewLogs: vi.fn(),
      onOpenPorts: vi.fn(),
    };
    const view = render(<ServicesPane {...props} connection={connection} />);
    await user.click(screen.getByRole("button", { name: /worker.service description/ }));
    await user.click(screen.getByText("Advanced", { selector: "summary" }));
    await waitFor(() => expect(api.listPorts).toHaveBeenCalledTimes(1));
    view.rerender(
      <ServicesPane {...props} connection={{ ...connection, destination: "another-host" }} />,
    );
    view.rerender(<ServicesPane {...props} connection={connection} />);
    await act(async () => {
      resolve([listener]);
    });
    expect(onPortsCacheChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Ports" })).toBeNull();
  });

  it("hides Ports when the listener read fails", async () => {
    const user = userEvent.setup();
    api.listPorts.mockRejectedValue(new Error("ss unavailable"));
    function Pane() {
      const [portsCache, setPortsCache] = useState<CachedList<ListeningSocket>>({
        items: [],
        fetchedAt: null,
        loading: false,
        error: null,
      });
      return (
        <ServicesPane
          connection={connection}
          cache={cache([unit("worker.service", "service", "active", "running")])}
          portsCache={portsCache}
          onPortsCacheChange={setPortsCache}
          onCacheChange={vi.fn()}
          onViewLogs={vi.fn()}
          onOpenPorts={vi.fn()}
        />
      );
    }
    render(<Pane />);
    await user.click(screen.getByRole("button", { name: /worker.service description/ }));
    await user.click(screen.getByText("Advanced", { selector: "summary" }));
    await waitFor(() => expect(api.listPorts).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Ports" })).toBeNull();
  });

  it("recovers a listener cache left loading by an earlier view", async () => {
    const user = userEvent.setup();
    api.listPorts.mockResolvedValue([listener]);
    function Pane() {
      const [portsCache, setPortsCache] = useState<CachedList<ListeningSocket>>({
        ...cache([listener]),
        loading: true,
      });
      return (
        <ServicesPane
          connection={connection}
          cache={cache([unit("worker.service", "service", "active", "running")])}
          portsCache={portsCache}
          onPortsCacheChange={setPortsCache}
          onCacheChange={vi.fn()}
          onViewLogs={vi.fn()}
          onOpenPorts={vi.fn()}
        />
      );
    }
    render(<Pane />);
    await user.click(screen.getByRole("button", { name: /worker.service description/ }));
    await user.click(screen.getByText("Advanced", { selector: "summary" }));
    expect(await screen.findByRole("button", { name: "Ports" })).toBeTruthy();
    expect(api.listPorts).toHaveBeenCalledTimes(1);
  });
  it.each(["button", "row", "escape"])(
    "clears the selection when closing the inspector by %s",
    async (method) => {
      const user = userEvent.setup();
      const onSelectionChange = vi.fn();
      render(
        <ServicesPane
          connection={connection}
          cache={cache([unit("a.service", "service", "active", "running")])}
          onCacheChange={vi.fn()}
          onViewLogs={vi.fn()}
          onSelectionChange={onSelectionChange}
        />,
      );
      const row = screen.getByRole("button", { name: /a.service description/ });
      await user.click(row);
      expect(row.getAttribute("aria-pressed")).toBe("true");
      if (method === "button")
        await user.click(screen.getByRole("button", { name: "Close details" }));
      else if (method === "row") await user.click(row);
      else await user.keyboard("{Escape}");
      expect(screen.queryByRole("complementary", { name: "Unit details" })).toBeNull();
      expect(row.getAttribute("aria-pressed")).toBe("false");
      expect(row.classList.contains("selected-row")).toBe(false);
      expect(document.querySelector(".systemd-selection-indicator")).toBeNull();
      expect(onSelectionChange).toHaveBeenLastCalledWith(null);
      expect(
        (screen.getByRole("button", { name: "Relationships" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      await user.click(row);
      expect(screen.getByRole("complementary", { name: "Unit details" })).toBeTruthy();
      expect(row.getAttribute("aria-pressed")).toBe("true");
    },
  );
  it("defaults to focused, restores its scope, and reveals a hidden selection without losing it", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    const props = {
      connection,
      cache: cache([
        unit("ssh.service", "service", "active", "running"),
        unit("systemd-udevd.service", "service", "active", "running"),
        unit("data.mount", "mount", "active", "mounted"),
        unit("broken.device", "device", "failed", "failed"),
      ]),
      onCacheChange: vi.fn(),
      onViewLogs: vi.fn(),
      onStateChange,
    };
    const view = render(<ServicesPane {...props} />);
    expect(screen.getByRole("button", { name: "Focused", pressed: true })).toBeTruthy();
    expect(screen.getByText("2 / 4 units")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /data.mount description/ })).toBeNull();
    expect(screen.getByRole("button", { name: /broken.device description/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "All units" }));
    expect(screen.getByText("4 units")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /data.mount description/ }));
    await user.click(screen.getByRole("button", { name: "Focused" }));
    expect(screen.queryByRole("heading", { name: "data.mount" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show selected unit" }));
    expect(screen.getByRole("heading", { name: "data.mount" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All units", pressed: true })).toBeTruthy();
    const saved = onStateChange.mock.lastCall![0];
    view.unmount();
    render(<ServicesPane {...props} initialState={saved} />);
    expect(screen.getByRole("button", { name: "All units", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: /systemd-udevd.service description/ })).toBeTruthy();
  });

  it("searches hidden units and includes every failed type from the failure shortcut", async () => {
    const user = userEvent.setup();
    render(
      <ServicesPane
        connection={connection}
        cache={cache([
          unit("systemd-udevd.service", "service", "active", "running"),
          unit("broken.mount", "mount", "failed", "failed"),
        ])}
        onCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Find units" }));
    await user.type(screen.getByRole("textbox", { name: "Search units" }), "udevd");
    expect(
      await screen.findByRole("button", { name: /systemd-udevd.service description/ }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "1 failed" }));
    expect(screen.getByRole("button", { name: /broken.mount description/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /systemd-udevd.service description/ })).toBeNull();
  });
  it("collapses unreachable descendants while retaining dependencies shared by an expanded branch", async () => {
    const user = userEvent.setup();
    const requirements: Record<string, string> = {
      "a.service": "b.service d.service",
      "b.service": "c.service",
      "d.service": "c.service",
      "c.service": "leaf.service",
    };
    api.inspectSystemdUnit.mockImplementation((_host, id) =>
      Promise.resolve(systemdInspection(id, { Requires: requirements[id] ?? "" })),
    );
    render(
      <ServicesPane
        connection={connection}
        cache={cache([unit("a.service", "service", "active", "running")])}
        onCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /a.service description/ }));
    await user.click(screen.getByRole("button", { name: /^Relationships(?: |$)/ }));
    await user.click(await screen.findByRole("button", { name: "Expand b.service" }));
    await user.click(await screen.findByRole("button", { name: "Expand c.service" }));
    await screen.findByRole("button", { name: /^leaf.service/ });
    await user.click(screen.getByRole("button", { name: "Expand d.service" }));
    await waitFor(() =>
      expect(api.inspectSystemdUnit).toHaveBeenCalledWith(connection.id, "d.service", "properties"),
    );
    await user.click(screen.getByRole("button", { name: "Collapse b.service" }));
    expect(await screen.findByRole("button", { name: /^leaf.service/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Collapse d.service" }));
    expect(screen.queryByRole("button", { name: /^leaf.service/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse c.service" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("button", { name: /^leaf.service/ })).toBeTruthy();
  });
  it("does not select the first unit when an inventory request completes", async () => {
    const items = [unit("a.service", "service", "active", "running")];
    api.listServices.mockResolvedValue(items);
    const onCacheChange = vi.fn();
    const onSelectionChange = vi.fn();
    render(
      <ServicesPane
        connection={connection}
        cache={{ items: [], fetchedAt: null, loading: false, error: null }}
        onCacheChange={onCacheChange}
        onSelectionChange={onSelectionChange}
        onViewLogs={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(onCacheChange).toHaveBeenCalledWith(
        expect.objectContaining({ items, loading: false }),
      ),
    );
    expect(onSelectionChange.mock.calls.every(([id]) => id === null)).toBe(true);
    expect(
      (screen.getByRole("button", { name: /^Relationships(?: |$)/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(api.inspectSystemdUnit).not.toHaveBeenCalled();
  });
  it("opens a graph inspector and frames its node immediately while details are pending", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    try {
      api.inspectSystemdUnit.mockImplementation((_host, id) =>
        id === "a.service"
          ? Promise.resolve(systemdInspection(id, { Requires: "b.service" }))
          : new Promise(() => {}),
      );
      const user = userEvent.setup();
      render(
        <ServicesPane
          connection={{ ...connection, id: "pending-details-host" }}
          cache={cache([unit("a.service", "service", "active", "running")])}
          onCacheChange={vi.fn()}
          onViewLogs={vi.fn()}
        />,
      );
      await user.click(screen.getByRole("button", { name: /a.service description/ }));
      await user.click(screen.getByRole("button", { name: /^Relationships(?: |$)/ }));
      const graph = screen.getByRole("region", { name: "Systemd dependency graph" });
      const node = await within(graph).findByRole("button", { name: /^b.service/ });
      const content = graph.querySelector<HTMLElement>(".systemd-graph-content")!;
      const before = content.style.transform;
      await user.click(node);
      expect(screen.getByRole("heading", { name: "b.service" })).toBeTruthy();
      expect(content.style.transform).not.toBe(before);
      expect(screen.getByText("Reading unit details…")).toBeTruthy();
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });
  it("never opens the graph when rapidly toggling an inventory inspector", async () => {
    const user = userEvent.setup();
    render(
      <ServicesPane
        connection={connection}
        cache={cache([unit("a.service", "service", "active", "running")])}
        onCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );
    const row = screen.getByRole("button", { name: /a.service description/ });
    await user.click(row);
    const relationships = screen.getByRole("button", { name: "Relationships a.service" });
    expect(relationships.textContent).toContain("a.service");
    expect(relationships.textContent).toContain("Relationships");
    await user.dblClick(row);
    expect(screen.queryByRole("region", { name: "Systemd dependency graph" })).toBeNull();
    expect(screen.getByRole("region", { name: "Systemd units" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("region", { name: "Systemd dependency graph" })).toBeNull();
  });
  afterEach(cleanup);
  beforeEach(() => {
    api.collectBootDiagnostics.mockReset();
    api.listPorts.mockReset();
    invalidateSystemdReads(connection.id);
    api.inspectSystemdUnit
      .mockReset()
      .mockImplementation((_connection, id) => Promise.resolve(systemdInspection(id)));
  });

  it("starts with a quiet list and reads details only after a row is selected", async () => {
    const user = userEvent.setup();
    render(
      <ServicesPane
        connection={connection}
        cache={cache([
          { ...unit("old.service", "service", "inactive", "dead"), unitFileState: "disabled" },
        ])}
        onCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(api.inspectSystemdUnit).not.toHaveBeenCalled();
    const row = screen.getByRole("button", { name: /old.service description/ });
    expect(row.getAttribute("aria-pressed")).toBe("false");
    expect(
      (screen.getByRole("button", { name: /^Relationships(?: |$)/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(row.textContent).toContain("Inactive");
    expect(row.textContent).not.toMatch(/dead|disabled/);
    expect(screen.queryByLabelText("Unit state")).toBeNull();
    await user.click(row);
    expect(screen.getByRole("complementary", { name: "Unit details" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(row.getAttribute("aria-pressed")).toBe("false");
  });

  it("starts the graph closed with a bounded dependency category and reveals more on request", async () => {
    const user = userEvent.setup();
    const neighbors = Array.from({ length: 30 }, (_, index) => "neighbor-" + index + ".service");
    api.inspectSystemdUnit.mockImplementation((_connection, id) =>
      Promise.resolve(
        systemdInspection(id, {
          Requires: neighbors.join(" "),
          After: "ordering.target",
          Triggers: "activation.service",
        }),
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
    await user.click(screen.getByRole("button", { name: /a.service description/ }));
    await user.click(screen.getByRole("button", { name: /^Relationships(?: |$)/ }));
    const graph = screen.getByRole("region", { name: "Systemd dependency graph" });
    await waitFor(() => expect(graph.querySelectorAll(".systemd-graph-node")).toHaveLength(7));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(graph.querySelectorAll("rect")).toHaveLength(0);
    expect(within(graph).queryByRole("button", { name: /^ordering.target/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Show more/ }));
    expect(graph.querySelectorAll(".systemd-graph-node")).toHaveLength(13);
    await user.click(screen.getByRole("button", { name: /Show more/ }));
    expect(graph.querySelectorAll(".systemd-graph-node")).toHaveLength(19);
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(graph.querySelectorAll(".systemd-graph-node")).toHaveLength(13);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(graph.querySelectorAll(".systemd-graph-node")).toHaveLength(19);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(graph.querySelectorAll(".systemd-graph-node")).toHaveLength(13);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(graph.querySelectorAll(".systemd-graph-node")).toHaveLength(7);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Show more/ }));
    await user.click(screen.getByRole("button", { name: "Ordering" }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(await within(graph).findByRole("button", { name: /^ordering.target/ })).toBeTruthy();
    expect(graph.querySelectorAll(".systemd-graph-node")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Activation" }));
    expect(await within(graph).findByRole("button", { name: /^activation.service/ })).toBeTruthy();
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
    expect(screen.getByText("4 units")).toBeTruthy();
    expect(screen.getByText(/2 failed/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Filter and sort units" }));
    await user.selectOptions(screen.getByLabelText("Unit state"), "failed");
    await user.selectOptions(screen.getByLabelText("Unit type"), "timer");
    expect(screen.getByRole("button", { name: /backup.timer/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^data.mount/i })).toBeNull();

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

    expect(screen.queryByText("0 failed")).toBeNull();
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

    await user.click(screen.getByRole("button", { name: "All units" }));
    await user.click(screen.getByRole("button", { name: /data.mount description/ }));
    expect(screen.getByRole("heading", { name: "data.mount" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Find units" }));
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
    expect(screen.getByRole("button", { name: "Relationships b.service" }).textContent).toContain(
      "b.service",
    );
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
    await user.click(screen.getByRole("button", { name: /a.service description/ }));
    await user.click(screen.getByRole("button", { name: /^Relationships(?: |$)/ }));
    expect(screen.getByTitle("Refocus on current unit").textContent).toBe("a.service");
    await user.click(screen.getByRole("button", { name: "Explorer" }));
    await user.click(screen.getByRole("button", { name: /b.service description/ }));
    await user.click(screen.getByRole("button", { name: /^Relationships(?: |$)/ }));
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
    await user.click(screen.getByRole("button", { name: /a.service description/ }));
    await user.click(screen.getByRole("button", { name: /^Relationships(?: |$)/ }));
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
    await user.click(screen.getByRole("button", { name: "Collapse b.service" }));
    expect(within(graph).queryByRole("button", { name: /^c.service/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await within(graph).findByRole("button", { name: /^c.service/ })).toBeTruthy();
    await user.dblClick(within(graph).getByRole("button", { name: /^b.service/ }));
    expect(screen.getByTitle("Refocus on current unit").textContent).toBe("b.service");
    expect(screen.queryByRole("complementary", { name: "Unit details" })).toBeNull();
    await user.click(within(graph).getByRole("button", { name: /^b.service/ }));
    expect(screen.getByRole("complementary", { name: "Unit details" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("complementary", { name: "Unit details" })).toBeNull();
    await user.click(within(graph).getByRole("button", { name: /^c.service/ }));
    expect(screen.getByTitle("Refocus on current unit").textContent).toBe("b.service");
    await user.click(screen.getByRole("button", { name: /^Relationships(?: |$)/ }));
    expect(screen.getByTitle("Refocus on current unit").textContent).toBe("c.service");
  });
});
