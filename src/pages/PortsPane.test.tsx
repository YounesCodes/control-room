// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CachedList, DockerContainer, ListeningSocket, SavedConnection } from "../types";
import { PortsPane } from "./PortsPane";

vi.mock("../lib/api", () => ({
  api: { listPorts: vi.fn(), listContainers: vi.fn() },
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

describe("PortsPane", () => {
  afterEach(cleanup);

  it("shows collection time and navigates only through established owners", async () => {
    const user = userEvent.setup();
    const onOpenSystemd = vi.fn();
    const onOpenContainer = vi.fn();
    const onViewLogs = vi.fn();
    render(
      <PortsPane
        connection={connection}
        cache={sockets}
        containersCache={containers}
        onCacheChange={vi.fn()}
        onContainersCacheChange={vi.fn()}
        onOpenSystemd={onOpenSystemd}
        onOpenContainer={onOpenContainer}
        onViewLogs={onViewLogs}
      />,
    );

    expect(screen.getByText(/collected at/i)).toBeTruthy();
    expect(screen.getAllByText("gateway-1")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /Open unit/i }));
    expect(onOpenSystemd).toHaveBeenCalledWith("nginx.service");
    await user.click(screen.getByRole("button", { name: /Open container/i }));
    expect(onOpenContainer).toHaveBeenCalledWith("container-id");
    await user.click(screen.getByRole("button", { name: /View journal/i }));
    expect(onViewLogs).toHaveBeenCalledWith({ type: "systemd", id: "nginx.service" });
  });
});
