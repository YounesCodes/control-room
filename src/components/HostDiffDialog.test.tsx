// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  compareTwoHosts: vi.fn(),
  cancelHostDiff: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;
  },
}));

import type { HostDiff, SavedConnection } from "../types";
import { HostDiffDialog } from "./HostDiffDialog";

function connection(id: string, name: string): SavedConnection {
  return {
    id,
    displayName: name,
    destination: `${id}.example`,
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
}

const connections = [connection("a", "web-01"), connection("b", "web-02")];

const diff: HostDiff = {
  left: { connectionId: "a", connectionName: "web-01", collectedAt: "2026-09-01T10:00:00Z" },
  right: { connectionId: "b", connectionName: "web-02", collectedAt: "2026-09-01T10:00:04Z" },
  collectionSkewSeconds: 4,
  sections: [
    {
      kind: "systemdUnits",
      leftStatus: "collected",
      rightStatus: "collected",
      comparable: true,
      note: null,
      rows: [
        {
          identity: "ssh.service",
          label: "ssh.service",
          state: "equal",
          facts: [{ name: "activeState", leftValue: "active", rightValue: "active", equal: true }],
        },
        {
          identity: "nginx.service",
          label: "nginx.service",
          state: "different",
          facts: [{ name: "activeState", leftValue: "active", rightValue: "failed", equal: false }],
        },
      ],
      equalCount: 1,
      differentCount: 1,
    },
    {
      kind: "containers",
      leftStatus: "collected",
      rightStatus: "unsupported",
      comparable: false,
      note: "Not comparable: on the right host the subsystem is not present.",
      rows: [],
      equalCount: 0,
      differentCount: 0,
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog() {
  const onOpenObject = vi.fn();
  render(
    <HostDiffDialog connections={connections} onClose={vi.fn()} onOpenObject={onOpenObject} />,
  );
  return onOpenObject;
}

describe("host diff dialog", () => {
  it("says the comparison is read-only and picks no winner", () => {
    renderDialog();
    expect(screen.getByText(/never changes a host and never says which one is right/)).toBeTruthy();
  });

  it("previews the scope before anything runs", () => {
    renderDialog();
    expect(
      screen.getByText(
        /Will read host facts, systemd units, listening sockets, containers, and filesystems from web-01/,
      ),
    ).toBeTruthy();
  });

  it("refuses to compare a connection with itself", async () => {
    renderDialog();
    await userEvent.selectOptions(screen.getAllByRole("combobox")[1], "a");
    expect(screen.getByText("Choose two different Saved Connections.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Compare/ }).hasAttribute("disabled")).toBe(true);
  });

  it("shows both collection times and only the differing facts by default", async () => {
    api.compareTwoHosts.mockResolvedValue(diff);
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /Compare/ }));
    expect(await screen.findByText("nginx.service")).toBeTruthy();
    expect(screen.queryByText("ssh.service")).toBeNull();
    expect(screen.getByText(/web-01 read at/)).toBeTruthy();
    expect(screen.getByText("1 difference, 1 section could not be compared")).toBeTruthy();
  });

  it("reveals equal rows when the filter is turned off", async () => {
    api.compareTwoHosts.mockResolvedValue(diff);
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /Compare/ }));
    await screen.findByText("nginx.service");
    await userEvent.click(screen.getByRole("checkbox", { name: /Differences only/ }));
    expect(screen.getByText("ssh.service")).toBeTruthy();
  });

  it("reports a section it could not compare instead of calling it equal", async () => {
    api.compareTwoHosts.mockResolvedValue(diff);
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /Compare/ }));
    expect(
      await screen.findByText("Not comparable: on the right host the subsystem is not present."),
    ).toBeTruthy();
    expect(screen.getByText("Not present")).toBeTruthy();
  });

  it("opens the object on whichever host the user picks", async () => {
    api.compareTwoHosts.mockResolvedValue(diff);
    const onOpenObject = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /Compare/ }));
    await screen.findByText("nginx.service");
    await userEvent.click(screen.getByRole("button", { name: "Right" }));
    expect(onOpenObject).toHaveBeenCalledWith("b", "services", "nginx.service");
  });

  it("sends only the two chosen connection ids and a run id", async () => {
    api.compareTwoHosts.mockResolvedValue(diff);
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /Compare/ }));
    await waitFor(() => expect(api.compareTwoHosts).toHaveBeenCalled());
    const request = api.compareTwoHosts.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(["leftConnectionId", "rightConnectionId", "runId"]);
    expect(request.leftConnectionId).toBe("a");
    expect(request.rightConnectionId).toBe("b");
  });

  it("surfaces a failure without showing a comparison", async () => {
    api.compareTwoHosts.mockRejectedValue(new Error("Choose two different Saved Connections"));
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /Compare/ }));
    expect(await screen.findByText("Choose two different Saved Connections")).toBeTruthy();
    expect(screen.queryByText("Systemd units")).toBeNull();
  });
});
