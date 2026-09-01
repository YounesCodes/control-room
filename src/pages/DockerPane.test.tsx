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
        onOpenObject={vi.fn()}
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
        onOpenObject={vi.fn()}
      />,
    );
    await user.click(screen.getByLabelText("Refresh container details"));
    await waitFor(() => expect(api.inspectContainer).toHaveBeenCalledTimes(2));
    expect(api.inspectContainer).toHaveBeenLastCalledWith(connection.id, id, null);
  });
});
