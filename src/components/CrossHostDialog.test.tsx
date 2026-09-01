// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listCrossHostOperations: vi.fn(),
  runCrossHostInspection: vi.fn(),
  cancelCrossHostInspection: vi.fn(),
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

import type { CrossHostOperation, CrossHostResult, SavedConnection } from "../types";
import { CrossHostDialog } from "./CrossHostDialog";

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

const operations: CrossHostOperation[] = [
  {
    id: "hostFacts",
    label: "Host facts",
    description: "Operating system, version, kernel, and architecture.",
    parameter: null,
    facts: ["hostname", "kernel"],
  },
  {
    id: "unitState",
    label: "Systemd unit state",
    description: "Load, active, sub, and unit-file state of one unit.",
    parameter: { kind: "systemdUnit", label: "Unit", placeholder: "nginx.service" },
    facts: ["loadState", "activeState"],
  },
];

const connections = [connection("a", "Alpha"), connection("b", "Bravo")];

function results(): CrossHostResult[] {
  return [
    {
      runId: "run-1",
      connectionId: "a",
      connectionName: "Alpha",
      state: "completed",
      message: null,
      collectedAt: "2026-09-01T10:00:00Z",
      facts: [
        { name: "hostname", value: "alpha" },
        { name: "kernel", value: "6.1.0" },
      ],
    },
    {
      runId: "run-1",
      connectionId: "b",
      connectionName: "Bravo",
      state: "unreachable",
      message: "Connection timed out",
      collectedAt: "2026-09-01T10:00:01Z",
      facts: [],
    },
  ];
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("cross-host dialog", () => {
  it("says the run is predefined and read-only", async () => {
    api.listCrossHostOperations.mockResolvedValue(operations);
    render(<CrossHostDialog connections={connections} onClose={vi.fn()} />);
    expect(
      await screen.findByText(/never runs a command you type here, and never changes a host/),
    ).toBeTruthy();
  });

  it("keeps the run disabled until targets are confirmed one by one", async () => {
    api.listCrossHostOperations.mockResolvedValue(operations);
    render(<CrossHostDialog connections={connections} onClose={vi.fn()} />);
    await screen.findByText("Host facts");
    const run = screen.getByRole("button", { name: /Run inspection/ });
    expect(run.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Tick at least one Saved Connection.")).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: /Alpha/ }));
    expect(screen.getByRole("button", { name: /Run inspection/ }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("previews the exact facts and hosts before anything runs", async () => {
    api.listCrossHostOperations.mockResolvedValue(operations);
    render(<CrossHostDialog connections={connections} onClose={vi.fn()} />);
    await screen.findByText("Host facts");
    await userEvent.click(screen.getByRole("checkbox", { name: /Alpha/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Bravo/ }));
    expect(screen.getByText("Will read hostname, kernel from 2 hosts: Alpha, Bravo.")).toBeTruthy();
  });

  it("blocks a parameter that is not one unit id", async () => {
    api.listCrossHostOperations.mockResolvedValue(operations);
    render(<CrossHostDialog connections={connections} onClose={vi.fn()} />);
    await screen.findByText("Host facts");
    await userEvent.selectOptions(screen.getAllByRole("combobox")[0], "unitState");
    await userEvent.click(screen.getByRole("checkbox", { name: /Alpha/ }));
    await userEvent.type(screen.getByRole("textbox"), "nginx; reboot");
    expect(screen.getByText("Enter one systemd unit id")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Run inspection/ }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("shows one row per host and never fills values for a host that failed", async () => {
    api.listCrossHostOperations.mockResolvedValue(operations);
    api.runCrossHostInspection.mockResolvedValue(results());
    render(<CrossHostDialog connections={connections} onClose={vi.fn()} />);
    await screen.findByText("Host facts");
    await userEvent.click(screen.getByRole("checkbox", { name: /Alpha/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Bravo/ }));
    await userEvent.click(screen.getByRole("button", { name: /Run inspection/ }));
    expect(await screen.findByText("6.1.0")).toBeTruthy();
    expect(screen.getByText("Unreachable")).toBeTruthy();
    expect(screen.getByText("Connection timed out")).toBeTruthy();
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getByText("1 read, 1 unavailable")).toBeTruthy();
  });

  it("sends only an operation id, a parameter, and confirmed target ids", async () => {
    api.listCrossHostOperations.mockResolvedValue(operations);
    api.runCrossHostInspection.mockResolvedValue([]);
    render(<CrossHostDialog connections={connections} onClose={vi.fn()} />);
    await screen.findByText("Host facts");
    await userEvent.click(screen.getByRole("checkbox", { name: /Bravo/ }));
    await userEvent.click(screen.getByRole("button", { name: /Run inspection/ }));
    await waitFor(() => expect(api.runCrossHostInspection).toHaveBeenCalled());
    const request = api.runCrossHostInspection.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual([
      "connectionIds",
      "operationId",
      "parameter",
      "runId",
    ]);
    expect(request.connectionIds).toEqual(["b"]);
    expect(request.operationId).toBe("hostFacts");
    expect(request.parameter).toBeNull();
  });

  it("surfaces a run failure without inventing results", async () => {
    api.listCrossHostOperations.mockResolvedValue(operations);
    api.runCrossHostInspection.mockRejectedValue(new Error("Select at least one Saved Connection"));
    render(<CrossHostDialog connections={connections} onClose={vi.fn()} />);
    await screen.findByText("Host facts");
    await userEvent.click(screen.getByRole("checkbox", { name: /Alpha/ }));
    await userEvent.click(screen.getByRole("button", { name: /Run inspection/ }));
    expect(await screen.findByText("Select at least one Saved Connection")).toBeTruthy();
  });
});
