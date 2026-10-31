// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CachedList,
  CachedValue,
  DockerContainer,
  DockerContainerDetails,
  SavedConnection,
} from "../types";
import { DockerPane } from "./DockerPane";

const api = vi.hoisted(() => ({
  listContainers: vi.fn(),
  inspectContainer: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const id = "a".repeat(64);
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
const container: DockerContainer = {
  id,
  name: "gateway-1",
  image: "gateway:latest",
  state: "running",
  status: "Up",
  ports: "",
  createdAt: "today",
  composeProject: null,
  composeService: null,
  composeContainerNumber: null,
  composeOneoff: null,
};
const details: DockerContainerDetails = {
  id,
  name: "gateway-1",
  imageReference: "gateway:latest",
  imageContentId: "sha256:abc",
  state: "running",
  running: true,
  paused: false,
  restarting: false,
  oomKilled: false,
  dead: false,
  exitCode: 0,
  startedAt: null,
  finishedAt: null,
  healthStatus: null,
  failingStreak: null,
  restartPolicy: "no",
  restartMaximumRetryCount: 0,
  publishedPorts: [],
  networks: [],
  mounts: [],
  composeProject: null,
  composeService: null,
  composeContainerNumber: null,
  composeOneoff: null,
};

describe("DockerPane container inspection", () => {
  it("uses a spinner while reading and an empty state only after the read completes", () => {
    const props = {
      connection,
      detailsCache: {},
      onCacheChange: vi.fn(),
      onDetailsCacheChange: vi.fn(),
      onViewLogs: vi.fn(),
    };
    const cache = { items: [], fetchedAt: Date.now(), loading: true, error: null };
    const { container: element, rerender } = render(<DockerPane {...props} cache={cache} />);
    expect(screen.getByText("Reading Docker containers…")).toBeTruthy();
    expect(element.querySelector(".panel-state .spinner")).toBeTruthy();
    expect(element.querySelector(".panel-state svg")).toBeNull();
    rerender(<DockerPane {...props} cache={{ ...cache, loading: false }} />);
    expect(screen.getByText("No containers found")).toBeTruthy();
    expect(element.querySelector(".panel-state .spinner")).toBeNull();
    rerender(<DockerPane {...props} cache={{ ...cache, items: [container] }} />);
    expect(element.querySelector(".arch-chip")).toBeTruthy();
    expect(element.querySelector(".panel-state")).toBeNull();
  });
  it("shows the detected host name and OS in the graph root", () => {
    const capabilities = {
      hostname: "debian-server",
      osName: "Debian GNU/Linux",
      osVersion: "13",
    } as import("../types").HostCapabilities;
    const { rerender } = render(
      <DockerPane
        connection={connection}
        capabilities={capabilities}
        cache={{ items: [container], fetchedAt: Date.now(), loading: false, error: null }}
        detailsCache={{}}
        onCacheChange={vi.fn()}
        onDetailsCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );
    expect(screen.getByText("Debian GNU/Linux 13")).toBeTruthy();
    expect(screen.getByText("debian-server")).toBeTruthy();
    rerender(
      <DockerPane
        connection={connection}
        capabilities={null}
        cache={{ items: [container], fetchedAt: Date.now(), loading: false, error: null }}
        detailsCache={{}}
        onCacheChange={vi.fn()}
        onDetailsCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );
    expect(screen.queryByText("Debian GNU/Linux 13")).toBeNull();
    expect(screen.getByText("Host")).toBeTruthy();
  });
  it("does not offer Linux sudo for a Windows Docker permission error", async () => {
    render(
      <DockerPane
        connection={connection}
        windowsHost
        cache={{ items: [], fetchedAt: null, loading: false, error: "permission denied" }}
        detailsCache={{}}
        onCacheChange={vi.fn()}
        onDetailsCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );
    expect(screen.getByText("permission denied")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry with sudo" })).toBeNull();
  });
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    api.listContainers.mockResolvedValue([container]);
    api.inspectContainer.mockResolvedValue(details);
  });

  it("loads and refreshes details with the selected full Docker ID", async () => {
    const user = userEvent.setup();
    let detailCache = {};
    const onDetailsCacheChange = vi.fn((containerId, cache) => {
      detailCache = { ...detailCache, [containerId]: cache };
    });
    const { rerender } = render(
      <DockerPane
        connection={connection}
        cache={{ items: [container], fetchedAt: Date.now(), loading: false, error: null }}
        detailsCache={detailCache}
        onCacheChange={vi.fn()}
        onDetailsCacheChange={onDetailsCacheChange}
        onViewLogs={vi.fn()}
      />,
    );

    expect(api.inspectContainer).not.toHaveBeenCalled();
    expect(screen.queryByRole("complementary")).toBeNull();
    await user.click(screen.getByRole("button", { name: /gateway-1.*running/ }));
    await waitFor(() => expect(api.inspectContainer).toHaveBeenCalledWith(connection.id, id, null));
    await waitFor(() =>
      expect(onDetailsCacheChange).toHaveBeenCalledWith(
        id,
        expect.objectContaining({ value: details }),
      ),
    );
    rerender(
      <DockerPane
        connection={connection}
        cache={{ items: [container], fetchedAt: Date.now(), loading: false, error: null }}
        detailsCache={detailCache}
        onCacheChange={vi.fn()}
        onDetailsCacheChange={onDetailsCacheChange}
        onViewLogs={vi.fn()}
      />,
    );
    await user.click(screen.getByLabelText("Refresh container details"));
    await waitFor(() => expect(api.inspectContainer).toHaveBeenCalledTimes(2));
    expect(api.inspectContainer).toHaveBeenLastCalledWith(connection.id, id, null);
  });

  it("hides stale details while the selected container is outside the search", async () => {
    const user = userEvent.setup();
    render(
      <DockerPane
        connection={connection}
        cache={{ items: [container], fetchedAt: Date.now(), loading: false, error: null }}
        detailsCache={{
          [id]: { value: details, fetchedAt: Date.now(), loading: false, error: null },
        }}
        onCacheChange={vi.fn()}
        onDetailsCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /gateway-1.*running/ }));
    expect(screen.getByRole("heading", { name: "gateway-1" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Find containers" }));
    await user.type(screen.getByPlaceholderText(/Search projects/), "database");

    expect(screen.queryByRole("heading", { name: "gateway-1" })).toBeNull();
    expect(screen.getAllByText("No matching containers")).toHaveLength(1);
    expect(screen.queryByRole("complementary")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    await user.click(screen.getByRole("button", { name: /gateway-1.*running/ }));
    expect(screen.getByRole("heading", { name: "gateway-1" })).toBeTruthy();
  });

  it("shows one empty graph without an inspector", () => {
    render(
      <DockerPane
        connection={connection}
        cache={{ items: [], fetchedAt: Date.now(), loading: false, error: null }}
        detailsCache={{}}
        onCacheChange={vi.fn()}
        onDetailsCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );

    expect(screen.getAllByText("No containers found")).toHaveLength(1);
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByText("Select a container")).toBeNull();
  });

  it("retains an incoming container selection while the inventory loads", async () => {
    function Harness() {
      const [cache, setCache] = useState<CachedList<DockerContainer>>({
        items: [],
        fetchedAt: null,
        loading: false,
        error: null,
      });
      const [detailsCache, setDetailsCache] = useState<
        Record<string, CachedValue<DockerContainerDetails>>
      >({});
      return (
        <DockerPane
          connection={connection}
          cache={cache}
          detailsCache={detailsCache}
          onCacheChange={setCache}
          onDetailsCacheChange={(containerId, value) =>
            setDetailsCache((current) => ({ ...current, [containerId]: value }))
          }
          onViewLogs={vi.fn()}
          focusId={id}
        />
      );
    }
    render(<Harness />);
    expect(await screen.findByRole("heading", { name: "gateway-1" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Container details" })).toBeTruthy();
    expect(api.inspectContainer).toHaveBeenCalledExactlyOnceWith(connection.id, id, null);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Close details" }));
    await user.click(screen.getByRole("button", { name: "Refresh containers" }));
    await waitFor(() => expect(api.listContainers).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("closes details when a refresh removes the selected container", () => {
    const props = {
      connection,
      detailsCache: {
        [id]: { value: details, fetchedAt: Date.now(), loading: false, error: null },
      },
      onCacheChange: vi.fn(),
      onDetailsCacheChange: vi.fn(),
      onViewLogs: vi.fn(),
      focusId: id,
    };
    const { rerender } = render(
      <DockerPane
        {...props}
        cache={{ items: [container], fetchedAt: Date.now(), loading: false, error: null }}
      />,
    );
    expect(screen.getByRole("complementary")).toBeTruthy();
    rerender(
      <DockerPane
        {...props}
        cache={{ items: [], fetchedAt: Date.now(), loading: false, error: null }}
      />,
    );
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.getByText("No containers found")).toBeTruthy();
  });

  it("keeps saved nodes visible and offers Linux sudo after a failed list refresh", () => {
    render(
      <DockerPane
        connection={connection}
        cache={{
          items: [container],
          fetchedAt: Date.now(),
          loading: false,
          error: "permission denied",
        }}
        detailsCache={{}}
        onCacheChange={vi.fn()}
        onDetailsCacheChange={vi.fn()}
        onViewLogs={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /gateway-1.*running/ })).toBeTruthy();
    expect(screen.getByText(/Showing saved results. Refresh failed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry with sudo" })).toBeTruthy();
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});
