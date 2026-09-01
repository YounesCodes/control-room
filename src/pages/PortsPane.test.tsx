// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CachedList, DockerContainer, ListeningSocket, SavedConnection } from "../types";
import { PortsPane } from "./PortsPane";

vi.mock("../lib/api", () => ({
  api: {
    listPorts: vi.fn(),
    listContainers: vi.fn(),
    inspectFirewall: vi.fn().mockResolvedValue({
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

function renderPane() {
  const onOpenSystemd = vi.fn();
  const onOpenContainer = vi.fn();
  const onViewLogs = vi.fn();
  render(
    <PortsPane
      connection={connection}
      capabilities={null}
      cache={sockets}
      containersCache={containers}
      onCacheChange={vi.fn()}
      onContainersCacheChange={vi.fn()}
      onOpenSystemd={onOpenSystemd}
      onOpenContainer={onOpenContainer}
      onViewLogs={onViewLogs}
    />,
  );
  return { onOpenSystemd, onOpenContainer, onViewLogs };
}

describe("PortsPane", () => {
  afterEach(cleanup);

  it("defaults to the Overview graph and navigates only through established owners", async () => {
    const user = userEvent.setup();
    const { onOpenSystemd, onOpenContainer, onViewLogs } = renderPane();

    expect(screen.getByText(/collected at/i)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    // Host root node and its owner node both render.
    expect(screen.getByText("Host")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /443/ }));

    await user.click(screen.getByRole("button", { name: /Open unit/i }));
    expect(onOpenSystemd).toHaveBeenCalledWith("nginx.service");
    await user.click(screen.getByRole("button", { name: /Open container/i }));
    expect(onOpenContainer).toHaveBeenCalledWith("container-id");
    await user.click(screen.getByRole("button", { name: /View journal/i }));
    expect(onViewLogs).toHaveBeenCalledWith({ type: "systemd", id: "nginx.service" });
  });

  it("keeps a precise table view with the same owner detail", async () => {
    const user = userEvent.setup();
    renderPane();

    await user.click(screen.getByRole("tab", { name: "Table" }));
    await user.click(screen.getByRole("button", { name: /443/ }));
    // Owner label in the row plus the container row in the detail panel.
    expect(screen.getAllByText("gateway-1")).toHaveLength(2);
  });

  it("aggregates established connections in the Connections tab", async () => {
    const user = userEvent.setup();
    renderPane();

    await user.click(screen.getByRole("tab", { name: "Connections" }));
    expect(await screen.findByText(/established connection/i)).toBeTruthy();
    expect(screen.getByText(/12 est · 3 addr/)).toBeTruthy();
  });
});
