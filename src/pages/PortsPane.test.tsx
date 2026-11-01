// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CachedList,
  DockerContainer,
  HostCapabilities,
  ListeningSocket,
  SavedConnection,
} from "../types";
import { api } from "../lib/api";
import { PortsPane } from "./PortsPane";

vi.mock("../lib/api", () => ({
  api: {
    listPorts: vi.fn(),
    listContainers: vi.fn(),
    inspectFirewall: vi.fn().mockResolvedValue({
      backend: "ufw",
      available: true,
      active: true,
      defaultIncoming: "deny",
      rules: [
        {
          to: "443/tcp",
          action: "ALLOW",
          from: "Anywhere",
          port: 443,
          protocol: "tcp",
          ipv6: false,
        },
      ],
      collectedAt: "",
    }),
    inspectConnections: vi.fn().mockResolvedValue({
      groups: [
        {
          key: "tcp:443:nginx.service",
          protocol: "tcp",
          localPort: 443,
          processName: "nginx",
          processId: 742,
          systemdUnit: "nginx.service",
          established: 12,
          remoteAddressCount: 3,
          remotes: [{ address: "203.0.113.9", count: 8 }],
        },
      ],
      totalEstablished: 12,
      truncated: false,
      collectedAt: "",
    }),
  },
  errorMessage: (error: unknown) => String(error),
}));

const connection: SavedConnection = {
  id: "connection-id",
  displayName: "Host",
  destination: "host",
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

const sockets: CachedList<ListeningSocket> = {
  items: [
    {
      id: "tcp:0.0.0.0:443:0",
      protocol: "tcp",
      addressFamily: "ipv4",
      localAddress: "0.0.0.0",
      port: 443,
      processName: "nginx",
      processId: 742,
      systemdUnit: "nginx.service",
      ownership: "known",
    },
  ],
  fetchedAt: Date.now(),
  loading: false,
  error: null,
};

const containers: CachedList<DockerContainer> = {
  items: [
    {
      id: "container-id",
      name: "gateway-1",
      image: "gateway:latest",
      state: "running",
      status: "Up",
      ports: "0.0.0.0:443->8443/tcp",
      createdAt: "today",
      composeProject: "proxy",
      composeService: "gateway",
      composeContainerNumber: 1,
      composeOneoff: false,
    },
  ],
  fetchedAt: Date.now(),
  loading: false,
  error: null,
};

function renderPane(
  capabilities: HostCapabilities | null = null,
  cache = sockets,
  containersCache = containers,
) {
  const onOpenSystemd = vi.fn();
  const onOpenContainer = vi.fn();
  const onViewLogs = vi.fn();
  const result = render(
    <PortsPane
      connection={connection}
      capabilities={capabilities}
      globalSudoEnabled={false}
      cache={cache}
      containersCache={containersCache}
      onCacheChange={vi.fn()}
      onContainersCacheChange={vi.fn()}
      onOpenSystemd={onOpenSystemd}
      onOpenContainer={onOpenContainer}
      onViewLogs={onViewLogs}
    />,
  );
  return { onOpenSystemd, onOpenContainer, onViewLogs, ...result };
}

describe("PortsPane", () => {
  it("scopes Systemd navigation by exact unit evidence and returns to that unit", async () => {
    const onOpenSystemd = vi.fn();
    const user = userEvent.setup();
    render(
      <PortsPane
        connection={connection}
        capabilities={null}
        globalSudoEnabled={false}
        cache={{
          ...sockets,
          items: [
            ...sockets.items,
            {
              ...sockets.items[0],
              id: "other",
              port: 8080,
              systemdUnit: "nginx-helper.service",
              processId: 1001,
            },
          ],
        }}
        containersCache={{ ...containers, items: [] }}
        onCacheChange={vi.fn()}
        onContainersCacheChange={vi.fn()}
        onOpenSystemd={onOpenSystemd}
        onOpenContainer={vi.fn()}
        onViewLogs={vi.fn()}
        focusUnit="nginx.service"
      />,
    );
    const graph = screen.getByRole("region", { name: "Ports graph" });
    expect(within(graph).getByRole("button", { name: /443/ })).toBeTruthy();
    expect(within(graph).queryByRole("button", { name: /8080/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "nginx.service" }));
    expect(onOpenSystemd).toHaveBeenCalledWith("nginx.service");
    await user.click(screen.getByRole("button", { name: "Clear unit filter" }));
    expect(within(graph).getByRole("button", { name: /8080/ })).toBeTruthy();
  });
  it.each(["ports", "docker"])(
    "uses a spinner while reading %s without graph data",
    async (source) => {
      const { container: element } = renderPane(
        null,
        { ...sockets, items: [], loading: source === "ports" },
        { ...containers, items: [], loading: source === "docker" },
      );
      expect(
        screen.getByText(
          source === "ports" ? "Reading listening ports…" : "Reading Docker containers…",
        ),
      ).toBeTruthy();
      expect(element.querySelector(".panel-state .spinner")).toBeTruthy();
      expect(element.querySelector(".panel-state svg")).toBeNull();
    },
  );

  it("does not show a loader for a completed empty Ports snapshot", () => {
    const { container: element } = renderPane(
      null,
      { ...sockets, items: [] },
      { ...containers, items: [] },
    );
    expect(screen.getByText("No ports match the current filters")).toBeTruthy();
    expect(element.querySelector(".panel-state .spinner")).toBeNull();
  });
  it("shows a spinner before the first listener read has returned", () => {
    const { container: element } = renderPane(
      null,
      { ...sockets, items: [], fetchedAt: null, loading: false },
      { ...containers, items: [] },
    );
    expect(screen.getByText("Reading listening ports…")).toBeTruthy();
    expect(element.querySelector(".panel-state .spinner")).toBeTruthy();
    expect(element.querySelector(".panel-state svg")).toBeNull();
  });
  it("keeps a genuine Docker daemon listener linked to its unit", async () => {
    const user = userEvent.setup();
    const { onOpenSystemd } = renderPane(
      null,
      {
        ...sockets,
        items: sockets.items.map((socket) => ({
          ...socket,
          port: 2375,
          systemdUnit: "docker.service",
        })),
      },
      { ...containers, items: [] },
    );
    await user.click(screen.getByRole("button", { name: /2375.*Listening/ }));
    await user.click(screen.getByRole("button", { name: "Open unit" }));
    expect(onOpenSystemd).toHaveBeenCalledWith("docker.service");
  });
  it.each(["docker.service", "docker.socket", "containerd.service", "containerd.socket"])(
    "does not present runtime unit %s as the service of a published container endpoint",
    async (unit) => {
      const user = userEvent.setup();
      renderPane(null, {
        ...sockets,
        items: sockets.items.map((socket) => ({ ...socket, systemdUnit: unit })),
      });
      await user.click(screen.getByRole("button", { name: /443.*8443/ }));
      expect(screen.queryByRole("button", { name: "Open unit" })).toBeNull();
      expect(screen.queryByRole("button", { name: "View journal" })).toBeNull();
      expect(screen.getByRole("button", { name: "Open container" })).toBeTruthy();
    },
  );
  afterEach(cleanup);

  it("keeps canvas tools collapsed and preserves active filters when dismissed", async () => {
    const user = userEvent.setup();
    renderPane();
    expect(screen.queryByRole("textbox", { name: "Search ports" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    const find = screen.getByRole("button", { name: "Find ports" });
    await user.click(find);
    expect(screen.queryByRole("button", { name: "Close port tools" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search ports" }));
    await user.type(screen.getByRole("textbox", { name: "Search ports" }), "unmatched");
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(find);
    expect(find.getAttribute("aria-pressed")).toBe("true");
    await user.click(find);
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search ports" }));
    await user.click(screen.getByRole("button", { name: "Filter ports" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Protocol filter" }), "udp");
    await user.click(screen.getByRole("button", { name: "Close port tools" }));
    expect(screen.getByRole("button", { name: "Filter ports" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Filter ports" }));
    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(screen.getByRole("button", { name: "Filter ports" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    await user.click(screen.getByRole("button", { name: "Close port tools" }));
    const summary = screen.getByTitle(/Last collected at/);
    await user.click(summary);
    expect(document.querySelector("#ports-tools")).toBeNull();
    expect(summary.tagName).toBe("H2");
    expect(summary.textContent?.trim()).toBe("Ports");
    expect(summary.title).toContain("1 listening port");
    expect(summary.title).toContain("Last collected at");
    expect(summary.title).toContain("12 active connections");
  });

  it("keeps Windows ownership and firewall failures free of sudo prompts", async () => {
    vi.mocked(api.inspectFirewall).mockRejectedValueOnce("Permission denied by Windows");
    vi.mocked(api.listContainers).mockClear();
    renderPane({ osId: "windows", dockerAvailable: false } as HostCapabilities, {
      ...sockets,
      items: sockets.items.map((socket) => ({
        ...socket,
        processName: null,
        systemdUnit: null,
        ownership: "unavailable",
      })),
    });
    await screen.findByText(/Permission denied by Windows/);
    expect(
      screen.getByText(/Some owning processes could not be read by this Windows SSH account/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sudo/i })).toBeNull();
    expect(api.listContainers).not.toHaveBeenCalled();
  });

  it("fills the workspace with one graph and opens listener details only after selection", async () => {
    const user = userEvent.setup();
    const { onOpenSystemd, onOpenContainer, onViewLogs } = renderPane();

    expect(screen.getByRole("region", { name: "Ports graph" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Port details" })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByText("Host")).toBeTruthy();
    const listener = screen.getByRole("button", { name: /443.*Listening/ });
    await user.click(listener);
    const inspector = screen.getByRole("complementary", { name: "Port details" });
    expect(within(inspector).getByText("IPV4")).toBeTruthy();
    expect(within(inspector).getAllByText("742")[0]).toBeTruthy();
    expect(within(inspector).getAllByText("gateway-1")[0]).toBeTruthy();
    expect(within(inspector).queryByText("proxy")).toBeNull();
    expect(within(inspector).getByText("UFW: allowed")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Open unit/i }));
    expect(onOpenSystemd).toHaveBeenCalledWith("nginx.service");
    await user.click(screen.getByRole("button", { name: /Open container/i }));
    expect(onOpenContainer).toHaveBeenCalledWith("container-id");
    await user.click(screen.getByRole("button", { name: /View journal/i }));
    expect(onViewLogs).toHaveBeenCalledWith({ type: "systemd", id: "nginx.service" });
    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("complementary", { name: "Port details" })).toBeNull();
    expect(document.activeElement).toBe(listener);
  });

  it("dismisses details with Escape and closes them when filters hide the selected item", async () => {
    const user = userEvent.setup();
    renderPane();
    await user.click(screen.getByRole("button", { name: /443.*Listening/ }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("complementary")));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).toBeNull();
    await user.click(screen.getByRole("button", { name: /443.*Listening/ }));
    await user.click(screen.getByRole("button", { name: "Filter ports" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Protocol filter" }), "udp");
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.getByText("No ports match the current filters")).toBeTruthy();
  });

  it("keeps container ownership and bindings in Ports with a link to Docker", async () => {
    const user = userEvent.setup();
    const { onOpenContainer, onViewLogs } = renderPane();
    await user.click(screen.getByRole("button", { name: "Filter ports" }));
    expect(screen.queryByRole("option", { name: "Docker-published" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /443.*8443/ }));
    const inspector = screen.getByRole("complementary");
    expect(within(inspector).queryByText("gateway:latest")).toBeNull();
    expect(within(inspector).queryByText("proxy")).toBeNull();
    expect(within(inspector).getByText("gateway-1")).toBeTruthy();
    expect(within(inspector).getByText("0.0.0.0:443 → 8443/tcp")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open container" }));
    expect(onOpenContainer).toHaveBeenCalledWith("container-id");
    expect(screen.queryByRole("button", { name: "View logs" })).toBeNull();
    expect(onViewLogs).not.toHaveBeenCalled();
  });

  it("offers a one-shot sudo retry after firewalld denies authorization", async () => {
    const user = userEvent.setup();
    const inspectFirewall = vi.mocked(api.inspectFirewall);
    inspectFirewall.mockClear();
    inspectFirewall.mockRejectedValueOnce("Permission denied: Authorization failed.");
    inspectFirewall.mockResolvedValueOnce({
      backend: "firewalld",
      available: true,
      active: true,
      defaultIncoming: null,
      rules: [],
      collectedAt: "",
    });
    renderPane();

    const retry = await screen.findByRole("button", { name: "Retry with sudo" });
    expect(screen.getByText(/Authorization failed/)).toBeTruthy();
    expect(inspectFirewall).toHaveBeenCalledExactlyOnceWith(connection.id, null);
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(retry);
    expect(screen.getByRole("dialog", { name: "Sudo required" })).toBeTruthy();
    await user.type(screen.getByLabelText(/^Password/), "test-only-password");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(inspectFirewall).toHaveBeenLastCalledWith(connection.id, "test-only-password");
      expect(screen.queryByText(/Authorization failed/)).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(inspectFirewall).toHaveBeenCalledTimes(2);
  });

  it("loads established connections alongside listeners and exposes remote endpoints", async () => {
    const user = userEvent.setup();
    const { onOpenSystemd } = renderPane();
    await user.click(await screen.findByRole("button", { name: /12 established/ }));
    const inspector = screen.getByRole("complementary");
    expect(within(inspector).getByText("203.0.113.9")).toBeTruthy();
    expect(within(inspector).getByText("12")).toBeTruthy();
    expect(within(inspector).getByText("3")).toBeTruthy();
    expect(within(inspector).getAllByText("742")[0]).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open unit" }));
    expect(onOpenSystemd).toHaveBeenCalledWith("nginx.service");
    await user.click(screen.getByRole("button", { name: "Find ports" }));
    await user.type(screen.getByRole("textbox", { name: "Search ports" }), "203.0.113.9");
    expect(screen.getByRole("button", { name: /12 established/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /443.*Listening/ })).toBeTruthy();
  });

  it("keeps saved connection evidence visible and reports a refresh failure", async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole("button", { name: /12 established/ });
    vi.mocked(api.inspectConnections).mockRejectedValueOnce("SSH disconnected");
    await user.click(screen.getByRole("button", { name: "Refresh ports" }));
    expect(
      await screen.findByText(/Showing saved connections. Refresh failed: SSH disconnected/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /12 established/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry connections" })).toBeTruthy();
  });

  it("keeps Docker and connection data available when the listener read fails", async () => {
    renderPane(null, { ...sockets, items: [], error: "Listener permission denied" });
    expect(screen.getByRole("region", { name: "Ports graph" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /443.*8443/ })).toBeTruthy();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Show established connections" }));
    await screen.findByRole("button", { name: /12 established/ });
    expect(
      screen.getByText(/Listening ports unavailable: Listener permission denied/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry ports" })).toBeTruthy();
  });

  it("reads Docker independently when the initial listener request fails", async () => {
    vi.mocked(api.listPorts).mockRejectedValueOnce("Listener read failed");
    vi.mocked(api.listContainers).mockClear().mockResolvedValueOnce(containers.items);
    renderPane(
      null,
      { ...sockets, items: [], fetchedAt: null },
      { ...containers, items: [], fetchedAt: null },
    );
    await waitFor(() => expect(api.listContainers).toHaveBeenCalledExactlyOnceWith(connection.id));
    expect(api.inspectConnections).toHaveBeenCalledWith(connection.id);
  });
});
