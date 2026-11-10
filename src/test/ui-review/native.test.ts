import { afterEach, expect, it, vi } from "vitest";
import type { SystemdUnit } from "../../types";

async function fixture(state: string, scenario = "systemd") {
  vi.resetModules();
  vi.stubGlobal("location", { search: `?scenario=${scenario}&state=${state}` });
  return import("./native");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("restores a Systemd workspace in the real App with synthetic data", async () => {
  const native = await fixture("populated");
  expect(await native.invoke("get_workspace_state")).toMatchObject({
    activeWorkspaceId: "example-workspace",
    workspaces: [expect.objectContaining({ connectionId: "host-a", view: "services" })],
  });
  expect(await native.invoke<SystemdUnit[]>("list_services")).toHaveLength(8);
  expect(
    await native.invoke("inspect_systemd_unit", { unit: "backup.service", section: "properties" }),
  ).toMatchObject({
    properties: { ActiveState: "failed" },
  });
});

it("opens dialogs over existing organization and live host readings", async () => {
  const native = await fixture("metrics", "dialogs");
  expect(await native.invoke("get_workspace_state")).toMatchObject({
    workspaces: [expect.objectContaining({ view: "terminal" })],
  });
  expect(await native.invoke("list_connection_groups")).toHaveLength(2);
  expect(await native.invoke("list_connection_tags")).toHaveLength(2);
  expect(await native.invoke("get_settings_contract")).toMatchObject({
    current: { hostMetricsEnabled: true },
  });
  expect(await native.invoke("sample_header_metrics")).toMatchObject({ gpuPercent: null });
  const groups = await fixture("groups", "dialogs");
  expect(await groups.invoke("get_settings_contract")).not.toMatchObject({
    current: { hostMetricsEnabled: true },
  });
  expect(await (await fixture("populated")).invoke("list_connection_groups")).toEqual([]);
});

it("fails every Ports read the way an unreachable host does", async () => {
  const native = await fixture("warnings", "ports");
  expect(await native.invoke("get_workspace_state")).toMatchObject({
    workspaces: [expect.objectContaining({ view: "ports" })],
  });
  await expect(native.invoke("list_ports")).rejects.toThrow("Connection timed out");
  await expect(native.invoke("list_containers")).rejects.toThrow("Connection timed out");
  await expect(native.invoke("inspect_connections")).rejects.toThrow("queue was busy");
  await expect(native.invoke("inspect_firewall")).rejects.toThrow("queue was busy");
  expect(await (await fixture("groups-no-tags", "dialogs")).invoke("list_connection_tags")).toEqual(
    [],
  );
});

it("keeps empty, failed, and stale inventories distinct", async () => {
  expect(await (await fixture("empty")).invoke("list_services")).toEqual([]);
  await expect((await fixture("error")).invoke("list_services")).rejects.toThrow(
    "Synthetic read failure",
  );
  const stale = await fixture("stale");
  expect(await stale.invoke<SystemdUnit[]>("list_services")).toHaveLength(8);
  await expect(stale.invoke("list_services")).rejects.toThrow("Synthetic read failure");
});

it("keeps a loading read pending and supplies long overflow evidence", async () => {
  const loading = await fixture("loading");
  let completed = false;
  void loading.invoke("list_services").then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  const units = await (await fixture("overflow")).invoke<SystemdUnit[]>("list_services");
  expect(units).toHaveLength(82);
  expect(units[0].id.length).toBeGreaterThan(150);
});

it("emits synthetic session state/output so App settles without a native session", async () => {
  vi.useFakeTimers();
  const native = await fixture("populated");
  const listener = vi.fn();
  const stop = await native.listen("session-state-changed", listener);
  const output = new native.Channel<ArrayBuffer>();
  output.onmessage = vi.fn();
  expect(await native.invoke("start_session", { output })).toMatchObject({
    sessionId: "example-session",
  });
  await vi.runAllTimersAsync();
  expect(listener).toHaveBeenCalledWith({
    payload: { sessionId: "example-session", state: "connected", reason: null },
  });
  expect(output.onmessage).toHaveBeenCalledOnce();
  stop();
});
