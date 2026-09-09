// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerContainer, DockerContainerDetails, SavedConnection } from "../types";
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
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(screen.getByRole("heading", { name: "gateway-1" })).toBeTruthy();
    await user.type(screen.getByPlaceholderText(/Search projects/), "database");

    expect(screen.queryByRole("heading", { name: "gateway-1" })).toBeNull();
    expect(screen.getAllByText("No matching containers")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("heading", { name: "gateway-1" })).toBeTruthy();
  });

  it("coordinates the empty list and detail states", () => {
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

    expect(screen.getAllByText("No containers found")).toHaveLength(2);
    expect(screen.queryByText("Select a container")).toBeNull();
  });
});
