// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listServices: vi.fn(),
  listContainers: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type { DockerContainer, SavedConnection, SystemdUnit } from "../types";
import { TerminalContextBar } from "./TerminalContextBar";

const connection: SavedConnection = {
  id: "connection-a",
  displayName: "Host A",
  destination: "host-a",
  username: "user",
  port: null,
  identityFile: null,
  historyEnabled: true,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

const nginx: SystemdUnit = {
  id: "nginx.service",
  unitType: "service",
  description: "Web server",
  loadState: "loaded",
  activeState: "active",
  subState: "running",
  unitFileState: "enabled",
};

const apiContainer: DockerContainer = {
  id: "f".repeat(64),
  name: "api",
  image: "api:latest",
  state: "running",
  status: "Up",
  ports: "",
  createdAt: "",
  composeProject: null,
  composeService: null,
  composeContainerNumber: null,
  composeOneoff: null,
};

function renderBar(kind: "systemdUnit" | "dockerContainer", id: string, sourceCommand: string) {
  const handlers = {
    onDismiss: vi.fn(),
    onOpenSystemd: vi.fn(),
    onOpenContainer: vi.fn(),
    onViewLogs: vi.fn(),
  };
  render(
    <TerminalContextBar
      connection={connection}
      reference={{ kind, id, sourceCommand }}
      {...handlers}
    />,
  );
  return handlers;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("terminal context bar", () => {
  it("shows the parsed object and the command it came from", () => {
    renderBar("systemdUnit", "nginx.service", "systemctl status nginx");
    expect(screen.getByText("Systemd unit")).toBeTruthy();
    expect(screen.getByText("nginx.service")).toBeTruthy();
    expect(screen.getByText("systemctl status nginx")).toBeTruthy();
  });

  it("re-reads the unit list before opening Systemd", async () => {
    api.listServices.mockResolvedValue([nginx]);
    const handlers = renderBar("systemdUnit", "nginx.service", "systemctl status nginx");
    await userEvent.click(screen.getByRole("button", { name: /Open in Systemd/ }));
    expect(api.listServices).toHaveBeenCalledWith("connection-a");
    expect(handlers.onOpenSystemd).toHaveBeenCalledWith("nginx.service");
  });

  it("opens container logs by the resolved full id", async () => {
    api.listContainers.mockResolvedValue([apiContainer]);
    const handlers = renderBar("dockerContainer", "api", "docker logs api");
    await userEvent.click(screen.getByRole("button", { name: /Follow logs/ }));
    expect(handlers.onViewLogs).toHaveBeenCalledWith({ type: "docker", id: apiContainer.id });
  });

  it("reports a removed object instead of opening a stale view", async () => {
    api.listServices.mockResolvedValue([]);
    const handlers = renderBar("systemdUnit", "nginx.service", "systemctl status nginx");
    await userEvent.click(screen.getByRole("button", { name: /Open in Systemd/ }));
    expect(handlers.onOpenSystemd).not.toHaveBeenCalled();
    expect(
      screen.getByText("No systemd unit named nginx.service is in the current list."),
    ).toBeTruthy();
  });

  it("surfaces an inspection failure without navigating", async () => {
    api.listContainers.mockRejectedValue(new Error("permission denied"));
    const handlers = renderBar("dockerContainer", "api", "docker logs api");
    await userEvent.click(screen.getByRole("button", { name: /Inspect container/ }));
    expect(handlers.onOpenContainer).not.toHaveBeenCalled();
    expect(screen.getByText("permission denied")).toBeTruthy();
  });

  it("clears the context on request", async () => {
    const handlers = renderBar("dockerContainer", "api", "docker logs api");
    await userEvent.click(screen.getByRole("button", { name: "Clear terminal context" }));
    expect(handlers.onDismiss).toHaveBeenCalled();
  });
});
