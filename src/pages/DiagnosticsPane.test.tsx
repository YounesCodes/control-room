// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listServices: vi.fn(),
  collectServiceDiagnostic: vi.fn(),
  cancelServiceDiagnostic: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type {
  CachedList,
  DiagnosticSectionKind,
  SavedConnection,
  ServiceDiagnosticSection,
  SystemdUnit,
} from "../types";
import { DiagnosticsPane } from "./DiagnosticsPane";

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

function unit(id: string, activeState = "active"): SystemdUnit {
  return {
    id,
    unitType: id.split(".").pop() ?? "service",
    description: id,
    loadState: "loaded",
    activeState,
    subState: activeState,
    unitFileState: "enabled",
  };
}

const services: CachedList<SystemdUnit> = {
  items: [unit("nginx.service", "failed"), unit("logrotate.timer")],
  fetchedAt: Date.now(),
  loading: false,
  error: null,
};

function baseSection(
  kind: DiagnosticSectionKind,
  overrides: Partial<ServiceDiagnosticSection> = {},
): ServiceDiagnosticSection {
  return {
    unit: "nginx.service",
    kind,
    status: "collected",
    source: `source for ${kind}`,
    collectedAt: "2026-09-01T10:00:00.000Z",
    note: null,
    state: null,
    journal: null,
    dependencies: null,
    listeners: null,
    ...overrides,
  };
}

const failedState = baseSection("state", {
  note: null,
  state: {
    id: "nginx.service",
    known: true,
    description: "A high performance web server",
    loadState: "loaded",
    activeState: "failed",
    subState: "failed",
    unitFileState: "enabled",
    unitType: "forking",
    remainAfterExit: false,
    result: "exit-code",
    mainPid: null,
    execMainPid: 812,
    execMainStatus: 1,
    execMainCode: "exited",
    restartCount: 2,
    conditionResult: true,
    assertResult: true,
    loadError: null,
    fragmentPath: "/lib/systemd/system/nginx.service",
    stateChangeTimestamp: "Mon 2026-09-01 10:00:00 UTC",
    activeEnterTimestamp: "Mon 2026-09-01 09:00:00 UTC",
    inactiveEnterTimestamp: "Mon 2026-09-01 10:00:00 UTC",
  },
});

const journalSection = baseSection("journal", {
  source: "journald, last 200 entries for this unit",
  journal: {
    lines: ["2026-09-01T10:00:00.000000+0000 web nginx[812]: bind() to 0.0.0.0:80 failed"],
    requestedLines: 200,
    reachedRequestedLines: false,
    empty: false,
  },
});

const dependencySection = baseSection("dependencies", {
  dependencies: {
    relations: [
      {
        kind: "after",
        units: [
          { id: "network.target", loadState: "loaded", activeState: "active", subState: "active" },
        ],
      },
    ],
    namedUnits: 1,
    resolvedUnits: 1,
    truncated: false,
    statesResolved: true,
  },
});

const listenerSection = baseSection("listeners", {
  note: "No listener was attributed to this unit. Some listeners on the host had no unambiguous owner, so this is not proof that none exists.",
  status: "partial",
  listeners: { sockets: [], totalListeners: 9, ownershipComplete: false },
});

function sectionFor(kind: DiagnosticSectionKind): ServiceDiagnosticSection {
  if (kind === "state") return failedState;
  if (kind === "journal") return journalSection;
  if (kind === "dependencies") return dependencySection;
  return listenerSection;
}

function renderPane(unitId: string | null = "nginx.service") {
  const onPaste = vi.fn();
  render(
    <DiagnosticsPane
      connection={connection}
      servicesCache={services}
      onServicesCacheChange={vi.fn()}
      unitId={unitId}
      onUnitChange={vi.fn()}
      onViewLogs={vi.fn()}
      onPaste={onPaste}
      canPaste
    />,
  );
  return { onPaste };
}

beforeEach(() => {
  api.listServices.mockResolvedValue(services.items);
  api.cancelServiceDiagnostic.mockResolvedValue(undefined);
  api.collectServiceDiagnostic.mockImplementation((request: { kind: DiagnosticSectionKind }) =>
    Promise.resolve(sectionFor(request.kind)),
  );
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("diagnostics pane", () => {
  it("collects every applicable section for a failed service", async () => {
    renderPane();
    await waitFor(() => expect(api.collectServiceDiagnostic).toHaveBeenCalledTimes(4));
    expect(api.collectServiceDiagnostic.mock.calls.map((call) => call[0].kind)).toEqual([
      "state",
      "journal",
      "dependencies",
      "listeners",
    ]);
    expect(await screen.findByText("failed (failed)")).toBeTruthy();
    expect(screen.getByText("Result reported by systemd: exit-code")).toBeTruthy();
    expect(screen.getByText("Last main process exited with status 1")).toBeTruthy();
    expect(
      screen.getByText("Facts as the host reported them. Control Room does not infer a cause."),
    ).toBeTruthy();
  });

  it("does not ask for a section that cannot apply to the unit type", async () => {
    renderPane("logrotate.timer");
    await waitFor(() => expect(api.collectServiceDiagnostic).toHaveBeenCalledTimes(3));
    expect(api.collectServiceDiagnostic.mock.calls.map((call) => call[0].kind)).not.toContain(
      "listeners",
    );
    expect(screen.getByText("This section does not apply to this unit type.")).toBeTruthy();
  });

  it("keeps a failed port section from hiding the journal", async () => {
    api.collectServiceDiagnostic.mockImplementation((request: { kind: DiagnosticSectionKind }) =>
      request.kind === "listeners"
        ? Promise.reject(new Error("Permission denied: ss"))
        : Promise.resolve(sectionFor(request.kind)),
    );
    renderPane();
    expect(await screen.findByText("Permission denied: ss")).toBeTruthy();
    expect(
      screen.getByText(
        "2026-09-01T10:00:00.000000+0000 web nginx[812]: bind() to 0.0.0.0:80 failed",
      ),
    ).toBeTruthy();
    expect(screen.getByText("failed (failed)")).toBeTruthy();
  });

  it("offers sudo only for a permission failure and retries just that section", async () => {
    api.collectServiceDiagnostic.mockImplementation((request: { kind: DiagnosticSectionKind }) =>
      request.kind === "listeners"
        ? Promise.reject(new Error("Permission denied: ss"))
        : Promise.resolve(sectionFor(request.kind)),
    );
    renderPane();
    await waitFor(() => expect(api.collectServiceDiagnostic).toHaveBeenCalledTimes(4));
    await userEvent.click(screen.getByRole("button", { name: "Retry with sudo" }));
    await userEvent.type(screen.getByLabelText(/Password/), "secret");
    api.collectServiceDiagnostic.mockResolvedValue(listenerSection);
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.collectServiceDiagnostic).toHaveBeenCalledTimes(5));
    const retry = api.collectServiceDiagnostic.mock.calls[4][0];
    expect(retry.kind).toBe("listeners");
    expect(retry.sudoPassword).toBe("secret");
    expect(
      api.collectServiceDiagnostic.mock.calls
        .slice(0, 4)
        .every((call) => call[0].sudoPassword === null),
    ).toBe(true);
  });

  it("does not offer sudo for a failure that is not about permission", async () => {
    api.collectServiceDiagnostic.mockRejectedValue(
      new Error("Feature is not installed on this host"),
    );
    renderPane();
    await waitFor(() => expect(api.collectServiceDiagnostic).toHaveBeenCalledTimes(4));
    expect(screen.queryByRole("button", { name: "Retry with sudo" })).toBeNull();
  });

  it("refreshes one section without touching the others", async () => {
    renderPane();
    await waitFor(() => expect(api.collectServiceDiagnostic).toHaveBeenCalledTimes(4));
    await userEvent.click(screen.getByRole("button", { name: "Refresh Recent journal" }));
    await waitFor(() => expect(api.collectServiceDiagnostic).toHaveBeenCalledTimes(5));
    expect(api.collectServiceDiagnostic.mock.calls[4][0].kind).toBe("journal");
    expect(screen.getByText("failed (failed)")).toBeTruthy();
  });

  it("cancels one running section and tells Rust which operation to drop", async () => {
    const pending: { resolve: ((section: ServiceDiagnosticSection) => void) | null } = {
      resolve: null,
    };
    api.collectServiceDiagnostic.mockImplementation((request: { kind: DiagnosticSectionKind }) => {
      if (request.kind !== "listeners") return Promise.resolve(sectionFor(request.kind));
      return new Promise<ServiceDiagnosticSection>((resolve) => {
        pending.resolve = resolve;
      });
    });
    renderPane();
    await waitFor(() => expect(api.collectServiceDiagnostic).toHaveBeenCalledTimes(4));
    const operationId = api.collectServiceDiagnostic.mock.calls[3][0].operationId;
    await userEvent.click(screen.getByRole("button", { name: "Cancel Listening sockets" }));
    expect(api.cancelServiceDiagnostic).toHaveBeenCalledWith(operationId);
    // A result that arrives after the cancel is discarded, not rendered.
    pending.resolve?.(listenerSection);
    await waitFor(() => expect(screen.getByText("failed (failed)")).toBeTruthy());
    expect(screen.queryByText("9 listeners were read on this host.")).toBeNull();
  });

  it("shows the listener wording that refuses to claim absence", async () => {
    renderPane();
    expect(
      await screen.findByText(
        "No listener was attributed to nginx.service, and owners were incomplete",
      ),
    ).toBeTruthy();
    expect(screen.getByText("9 listeners were read on this host.")).toBeTruthy();
  });

  it("types systemctl status into the terminal instead of running it", async () => {
    const { onPaste } = renderPane();
    await waitFor(() => expect(api.collectServiceDiagnostic).toHaveBeenCalledTimes(4));
    await userEvent.click(
      screen.getByRole("button", { name: /Put systemctl status in the terminal/ }),
    );
    expect(onPaste).toHaveBeenCalledWith("systemctl status nginx.service");
    expect(
      screen.getByText(
        "The command is typed for you and waits for Enter. Control Room never runs it.",
      ),
    ).toBeTruthy();
  });

  it("shows section provenance and read time", async () => {
    renderPane();
    expect(await screen.findByText(/source for state · read at/)).toBeTruthy();
    expect(screen.getByText(/journald, last 200 entries for this unit · read at/)).toBeTruthy();
  });
});
