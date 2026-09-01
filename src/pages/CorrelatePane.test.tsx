// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listServices: vi.fn(),
  listContainers: vi.fn(),
  startJournalStream: vi.fn(),
  startDockerLogStream: vi.fn(),
  stopLogStream: vi.fn(),
}));

const channels = vi.hoisted(() => ({
  created: [] as { onmessage: ((m: unknown) => void) | null }[],
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;
    constructor() {
      channels.created.push(this);
    }
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => undefined),
}));

import type {
  AppSettings,
  CachedList,
  DockerContainer,
  SavedConnection,
  SystemdUnit,
} from "../types";
import { CorrelatePane } from "./CorrelatePane";

const connection: SavedConnection = {
  id: "connection-a",
  displayName: "Host A",
  destination: "host-a",
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

const settings = { defaultLogTail: 200 } as AppSettings;

function unit(id: string): SystemdUnit {
  return {
    id,
    unitType: "service",
    description: id,
    loadState: "loaded",
    activeState: "active",
    subState: "running",
    unitFileState: "enabled",
  };
}

function container(id: string, name: string): DockerContainer {
  return {
    id,
    name,
    image: "image:latest",
    state: "running",
    status: "Up",
    ports: "",
    createdAt: "",
    composeProject: null,
    composeService: null,
    composeContainerNumber: null,
    composeOneoff: null,
  };
}

const services: CachedList<SystemdUnit> = {
  items: [unit("nginx.service"), unit("ssh.service")],
  fetchedAt: Date.now(),
  loading: false,
  error: null,
};
const containers: CachedList<DockerContainer> = {
  items: [container("f".repeat(64), "api")],
  fetchedAt: Date.now(),
  loading: false,
  error: null,
};

function renderPane() {
  render(
    <CorrelatePane
      connection={connection}
      settings={settings}
      logTailOptions={[50, 200]}
      servicesCache={services}
      containersCache={containers}
      onServicesCacheChange={vi.fn()}
      onContainersCacheChange={vi.fn()}
    />,
  );
}

function emit(index: number, text: string) {
  const channel = channels.created[index];
  channel.onmessage?.(new TextEncoder().encode(text).buffer);
}

beforeEach(() => {
  // Every api call the pane makes returns a promise in the real app, including
  // the stop it issues while unmounting.
  api.listServices.mockResolvedValue(services.items);
  api.listContainers.mockResolvedValue(containers.items);
  api.stopLogStream.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  channels.created.length = 0;
  vi.resetAllMocks();
});

describe("correlate pane", () => {
  it("says the merged view is memory only", () => {
    renderPane();
    expect(
      screen.getByText("Merged in memory only. Control Room never stores fetched log lines."),
    ).toBeTruthy();
    expect(screen.getByText("No sources yet")).toBeTruthy();
  });

  it("asks Docker for timestamps so its lines can be ordered", async () => {
    api.startDockerLogStream.mockResolvedValue({ streamId: "stream-1" });
    renderPane();
    await userEvent.selectOptions(screen.getByLabelText("Source type"), "docker");
    await userEvent.selectOptions(screen.getByLabelText("Source"), "f".repeat(64));
    await userEvent.click(screen.getByRole("button", { name: /Add source/ }));
    await waitFor(() => expect(api.startDockerLogStream).toHaveBeenCalled());
    const call = api.startDockerLogStream.mock.calls[0];
    expect(call[6]).toBe(true);
  });

  it("merges two sources into one timeline with their own labels", async () => {
    api.startJournalStream.mockResolvedValue({ streamId: "stream-1" });
    renderPane();
    await userEvent.selectOptions(screen.getByLabelText("Source"), "nginx.service");
    await userEvent.click(screen.getByRole("button", { name: /Add source/ }));
    await waitFor(() => expect(api.startJournalStream).toHaveBeenCalledTimes(1));
    api.startJournalStream.mockResolvedValue({ streamId: "stream-2" });
    await userEvent.selectOptions(screen.getByLabelText("Source"), "ssh.service");
    await userEvent.click(screen.getByRole("button", { name: /Add source/ }));
    await waitFor(() => expect(api.startJournalStream).toHaveBeenCalledTimes(2));

    emit(0, "2026-09-01T10:00:02.000Z web nginx[1]: replied\n");
    emit(1, "2026-09-01T10:00:01.000Z web sshd[2]: accepted\n");

    expect(await screen.findByText("web sshd[2]: accepted")).toBeTruthy();
    const messages = screen.getAllByText(/web (nginx|sshd)/).map((element) => element.textContent);
    expect(messages).toEqual(["web sshd[2]: accepted", "web nginx[1]: replied"]);
    expect(screen.getByText("late")).toBeTruthy();
  });

  it("keeps other sources running when one fails to start", async () => {
    api.startJournalStream.mockResolvedValueOnce({ streamId: "stream-1" });
    renderPane();
    await userEvent.selectOptions(screen.getByLabelText("Source"), "nginx.service");
    await userEvent.click(screen.getByRole("button", { name: /Add source/ }));
    await waitFor(() => expect(screen.getByText("running")).toBeTruthy());

    api.startJournalStream.mockRejectedValueOnce(new Error("Permission denied"));
    await userEvent.selectOptions(screen.getByLabelText("Source"), "ssh.service");
    await userEvent.click(screen.getByRole("button", { name: /Add source/ }));
    expect(await screen.findByText("Permission denied")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByText("error")).toBeTruthy();
  });

  it("refuses to add the same source twice", async () => {
    api.startJournalStream.mockResolvedValue({ streamId: "stream-1" });
    renderPane();
    await userEvent.selectOptions(screen.getByLabelText("Source"), "nginx.service");
    await userEvent.click(screen.getByRole("button", { name: /Add source/ }));
    await waitFor(() => expect(api.startJournalStream).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: /Add source/ }));
    expect(screen.getByText("nginx.service is already in this correlation.")).toBeTruthy();
    expect(api.startJournalStream).toHaveBeenCalledTimes(1);
  });

  it("pauses rendering without stopping the streams", async () => {
    api.startJournalStream.mockResolvedValue({ streamId: "stream-1" });
    renderPane();
    await userEvent.selectOptions(screen.getByLabelText("Source"), "nginx.service");
    await userEvent.click(screen.getByRole("button", { name: /Add source/ }));
    await waitFor(() => expect(api.startJournalStream).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Pause merged view" }));
    emit(0, "2026-09-01T10:00:02.000Z web nginx[1]: replied\n");
    expect(screen.getByText("Paused. The streams keep running.")).toBeTruthy();
    expect(api.stopLogStream).not.toHaveBeenCalled();
    expect(screen.queryByText("web nginx[1]: replied")).toBeNull();
  });

  it("stops only the stream it removes", async () => {
    api.startJournalStream.mockResolvedValue({ streamId: "stream-1" });
    api.stopLogStream.mockResolvedValue(undefined);
    renderPane();
    await userEvent.selectOptions(screen.getByLabelText("Source"), "nginx.service");
    await userEvent.click(screen.getByRole("button", { name: /Add source/ }));
    await waitFor(() => expect(api.startJournalStream).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Remove nginx.service" }));
    await waitFor(() => expect(api.stopLogStream).toHaveBeenCalledWith("stream-1"));
    expect(screen.getByText("No sources yet")).toBeTruthy();
  });
});
