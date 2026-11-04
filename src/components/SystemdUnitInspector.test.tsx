// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SystemdUnitInspector } from "./SystemdUnitInspector";
import { systemdInspection } from "../test/systemd-fixtures";
import { invalidateSystemdReads } from "../lib/systemd-inspection";
import type { SystemdInspection } from "../types";
const api = vi.hoisted(() => ({ inspectSystemdUnit: vi.fn() }));
vi.mock("../lib/api", () => ({ api, errorMessage: String }));
beforeEach(() => {
  invalidateSystemdReads("host");
  api.inspectSystemdUnit
    .mockReset()
    .mockImplementation((_host, id) =>
      Promise.resolve(systemdInspection(id, {}, "[Service]\nRestart=on-failure")),
    );
});
afterEach(cleanup);

function inspector(value: SystemdInspection) {
  const props = {
    connectionId: "host",
    unitId: value.id,
    summary: null,
    revision: 0,
    result: { value, fetchedAt: Date.now(), loading: false, error: null },
    onRefresh: vi.fn(),
    onNavigate: vi.fn(),
    onViewLogs: vi.fn(),
    onOpenPorts: vi.fn(),
    onOpenBoot: vi.fn(),
  };
  render(<SystemdUnitInspector {...props} />);
  return props;
}

it("shows service execution evidence, actual uptime and unavailable resource sentinels", () => {
  inspector(
    systemdInspection("worker.service", {
      ActiveState: "failed",
      Result: "exit-code",
      ExecMainCode: "1",
      ExecMainStatus: "1",
      MainPID: "0",
      NRestarts: "4",
      Restart: "on-failure",
      MemoryCurrent: "18446744073709551615",
    }),
  );
  expect(screen.getByText("Failure evidence")).toBeTruthy();
  expect(screen.getByText("exit-code")).toBeTruthy();
  expect(screen.getByText("1")).toBeTruthy();
  expect(screen.queryByText("Execution result")).toBeNull();
  expect(screen.queryByText("Not assigned")).toBeNull();
  expect(screen.queryByText(/18446744073709551615/)).toBeNull();
  expect(api.inspectSystemdUnit).not.toHaveBeenCalled();
});

it("computes uptime from the host collection time rather than the local wall clock", () => {
  inspector(
    systemdInspection("worker.service", {
      ActiveState: "active",
      ActiveEnterTimestamp: "Sun 2026-11-01 09:00:00 UTC",
      ControlRoomRealtimeSeconds: String(Date.parse("2026-11-01T10:01:00Z") / 1000),
    }),
  );
  expect(screen.getByText("1h 1m")).toBeTruthy();
});

it.each([
  [
    "backup.timer",
    {
      NextElapseUSecRealtime: "Sun 2026-11-01 12:00:00 UTC",
      LastTriggerUSec: "Sat 2026-10-31 12:00:00 UTC",
      TimersCalendar: "OnCalendar=daily",
      Unit: "backup.service",
    },
    "backup.service",
  ],
  ["api.socket", { Listen: "[::]:8080 (Stream)", Triggers: "api.service" }, "[::]:8080 (Stream)"],
  [
    "data.mount",
    { Where: "/srv/data", What: "/dev/sdb1", Type: "ext4", Options: "rw,noatime" },
    "ext4",
  ],
] as const)("shows type-aware evidence for %s", (id, properties, expected) => {
  inspector(systemdInspection(id, properties));
  expect(screen.getByText(expected)).toBeTruthy();
});

it("keeps configuration directly accessible, reads it on demand, and opens the full journal", async () => {
  const user = userEvent.setup();
  const props = inspector(
    systemdInspection("worker.service", {
      ActiveState: "failed",
      Requires: "database.service",
      FragmentPath: "/etc/systemd/system/worker.service",
    }),
  );
  expect(api.inspectSystemdUnit).not.toHaveBeenCalled();
  expect(screen.queryByText("Recent journal")).toBeNull();
  expect([...document.querySelectorAll("summary")].map((summary) => summary.textContent)).toEqual([
    "Dependencies",
    "Configuration",
    "Advanced",
  ]);
  await user.click(screen.getByText("Configuration", { selector: "summary" }));
  await waitFor(() =>
    expect(api.inspectSystemdUnit).toHaveBeenCalledWith("host", "worker.service", "configuration"),
  );
  await user.click(screen.getByText("Advanced", { selector: "summary" }));
  await user.click(screen.getByText("Effective properties", { selector: "summary" }));
  await waitFor(() =>
    expect(api.inspectSystemdUnit).toHaveBeenCalledWith(
      "host",
      "worker.service",
      "effectiveConfiguration",
    ),
  );
  await user.click(screen.getByRole("button", { name: "View journal" }));
  expect(props.onViewLogs).toHaveBeenCalledWith({ type: "systemd", id: "worker.service" });
  expect(api.inspectSystemdUnit.mock.calls.some(([, , section]) => section === "journal")).toBe(
    false,
  );
  await user.click(screen.getByText("Dependencies", { selector: "summary" }));
  await user.click(screen.getByRole("button", { name: /database.service.*Requires/ }));
  expect(props.onNavigate).toHaveBeenCalledWith("database.service");
  await user.click(screen.getByRole("button", { name: "Ports" }));
  expect(props.onOpenPorts).toHaveBeenCalledWith("worker.service");
  await user.click(screen.getByRole("button", { name: "Boot" }));
  expect(props.onOpenBoot).toHaveBeenCalled();
  await user.click(screen.getByText("Advanced", { selector: "summary" }));
  expect(screen.getByText("Configuration", { selector: "summary" }).closest("details")?.open).toBe(
    true,
  );
  expect(screen.getByText(/Restart=on-failure/).closest("details")?.open).toBe(true);
});
