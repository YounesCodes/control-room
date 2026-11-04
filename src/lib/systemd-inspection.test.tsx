// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { systemdInspection } from "../test/systemd-fixtures";
const api = vi.hoisted(() => ({ inspectSystemdUnit: vi.fn() }));
vi.mock("./api", () => ({ api, errorMessage: String }));
import { invalidateSystemdReads, useSystemdReads } from "./systemd-inspection";

beforeEach(() => {
  invalidateSystemdReads("host");
  invalidateSystemdReads("other");
  api.inspectSystemdUnit.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("refreshes only the inspected service, keeps saved memory on failure, and pauses when hidden", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  api.inspectSystemdUnit.mockImplementation((_host, id) =>
    Promise.resolve(systemdInspection(id, { MemoryCurrent: "1048576" })),
  );
  const hook = renderHook(
    ({ live }) =>
      useSystemdReads("host", ["a.service", "b.service"], 0, "properties", "target", live),
    { initialProps: { live: "a.service" as string | null } },
  );
  await act(async () => {});
  api.inspectSystemdUnit.mockResolvedValueOnce(
    systemdInspection("a.service", { MemoryCurrent: "2097152" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(hook.result.current["a.service"].value?.properties.MemoryCurrent).toBe("2097152");
  expect(api.inspectSystemdUnit.mock.calls.map((call) => call[1])).toEqual([
    "a.service",
    "b.service",
    "a.service",
  ]);
  api.inspectSystemdUnit.mockRejectedValueOnce(new Error("Disconnected"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(hook.result.current["a.service"].value?.properties.MemoryCurrent).toBe("2097152");
  expect(hook.result.current["a.service"].error).toContain("Disconnected");
  hidden.mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(api.inspectSystemdUnit).toHaveBeenCalledTimes(4);
  hidden.mockReturnValue(false);
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(api.inspectSystemdUnit).toHaveBeenCalledTimes(5);
  expect(hook.result.current["a.service"].error).toBeNull();
  hook.rerender({ live: null });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(api.inspectSystemdUnit).toHaveBeenCalledTimes(5);
});

it("does not overlap slow live reads or apply them after the target changes", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  api.inspectSystemdUnit.mockResolvedValueOnce(
    systemdInspection("a.service", { MemoryCurrent: "1" }),
  );
  const hook = renderHook(
    ({ scope }) => useSystemdReads("host", ["a.service"], 0, "properties", scope, "a.service"),
    { initialProps: { scope: "first" } },
  );
  await act(async () => {});
  let finish!: (value: ReturnType<typeof systemdInspection>) => void;
  api.inspectSystemdUnit.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12000);
  });
  expect(api.inspectSystemdUnit).toHaveBeenCalledTimes(2);
  api.inspectSystemdUnit.mockResolvedValueOnce(
    systemdInspection("a.service", { MemoryCurrent: "2" }),
  );
  hook.rerender({ scope: "second" });
  await act(async () => {});
  await act(async () => finish(systemdInspection("a.service", { MemoryCurrent: "retired" })));
  expect(hook.result.current["a.service"].value?.properties.MemoryCurrent).toBe("2");
  hook.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(api.inspectSystemdUnit).toHaveBeenCalledTimes(3);
});

it("keeps a changed SSH target separate even when its Saved Connection ID is unchanged", async () => {
  api.inspectSystemdUnit
    .mockResolvedValueOnce(systemdInspection("a.service", { Description: "First host" }))
    .mockResolvedValueOnce(systemdInspection("a.service", { Description: "Second host" }));
  const hook = renderHook(
    ({ scope }) => useSystemdReads("host", ["a.service"], 0, "properties", scope),
    { initialProps: { scope: "first-target" } },
  );
  await waitFor(() =>
    expect(hook.result.current["a.service"]?.value?.properties.Description).toBe("First host"),
  );
  hook.rerender({ scope: "second-target" });
  await waitFor(() =>
    expect(hook.result.current["a.service"]?.value?.properties.Description).toBe("Second host"),
  );
  expect(api.inspectSystemdUnit).toHaveBeenCalledTimes(2);
});

it("deduplicates fresh reads and separates connections and sections", async () => {
  api.inspectSystemdUnit.mockImplementation((_host, id) => Promise.resolve(systemdInspection(id)));
  const a = renderHook(() => useSystemdReads("host", ["a.service"], 0));
  const b = renderHook(() => useSystemdReads("host", ["a.service"], 0));
  await waitFor(() => expect(a.result.current["a.service"]?.value?.id).toBe("a.service"));
  await waitFor(() => expect(b.result.current["a.service"]?.loading).toBe(false));
  expect(api.inspectSystemdUnit).toHaveBeenCalledTimes(1);
  renderHook(() => useSystemdReads("other", ["a.service"], 0));
  renderHook(() => useSystemdReads("host", ["a.service"], 0, "journal"));
  await waitFor(() => expect(api.inspectSystemdUnit).toHaveBeenCalledTimes(3));
});

it("retires queued responses when a connection changes target and then changes back", async () => {
  let finish!: (value: ReturnType<typeof systemdInspection>) => void;
  api.inspectSystemdUnit
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    )
    .mockResolvedValueOnce(systemdInspection("a.service", { Description: "Second target" }))
    .mockResolvedValueOnce(systemdInspection("a.service", { Description: "First target again" }));
  const hook = renderHook(
    ({ scope }) => useSystemdReads("host", ["a.service"], 0, "properties", scope),
    { initialProps: { scope: "first-target" } },
  );
  hook.rerender({ scope: "second-target" });
  await waitFor(() =>
    expect(hook.result.current["a.service"]?.value?.properties.Description).toBe("Second target"),
  );
  await act(async () =>
    finish(systemdInspection("a.service", { Description: "Retired response" })),
  );
  hook.rerender({ scope: "first-target" });
  await waitFor(() =>
    expect(hook.result.current["a.service"]?.value?.properties.Description).toBe(
      "First target again",
    ),
  );
  expect(api.inspectSystemdUnit).toHaveBeenCalledTimes(3);
});

it("ignores late replies after selection changes and unmount cancels queued work", async () => {
  let resolve!: (value: ReturnType<typeof systemdInspection>) => void;
  api.inspectSystemdUnit
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockImplementation((_host, id) => Promise.resolve(systemdInspection(id)));
  const hook = renderHook(({ id }) => useSystemdReads("host", [id], 0), {
    initialProps: { id: "a.service" },
  });
  hook.rerender({ id: "b.service" });
  await waitFor(() => expect(hook.result.current["b.service"]?.value?.id).toBe("b.service"));
  await act(async () => resolve(systemdInspection("a.service")));
  expect(hook.result.current["a.service"]).toBeUndefined();
  expect(hook.result.current["b.service"]?.value?.id).toBe("b.service");
  api.inspectSystemdUnit.mockReset().mockImplementation(() => new Promise(() => undefined));
  const queued = renderHook(() =>
    useSystemdReads("host", ["c.service", "d.service", "e.service"], 0),
  );
  expect(api.inspectSystemdUnit).toHaveBeenCalledTimes(2);
  queued.unmount();
  expect(api.inspectSystemdUnit).not.toHaveBeenCalledWith("host", "e.service", "properties");
});

it("refreshes without losing saved evidence when the host refuses a read", async () => {
  api.inspectSystemdUnit.mockResolvedValueOnce(
    systemdInspection("a.service", { Result: "exit-code" }),
  );
  const hook = renderHook(({ revision }) => useSystemdReads("host", ["a.service"], revision), {
    initialProps: { revision: 0 },
  });
  await waitFor(() => expect(hook.result.current["a.service"]?.value).toBeTruthy());
  invalidateSystemdReads("host");
  api.inspectSystemdUnit.mockRejectedValueOnce(new Error("Permission denied"));
  hook.rerender({ revision: 1 });
  await waitFor(() =>
    expect(hook.result.current["a.service"]?.error).toContain("Permission denied"),
  );
  expect(hook.result.current["a.service"]?.value?.properties.Result).toBe("exit-code");
});

it("does not let an old refresh overwrite newer cached evidence", async () => {
  let finish!: (value: ReturnType<typeof systemdInspection>) => void;
  api.inspectSystemdUnit.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  const hook = renderHook(({ revision }) => useSystemdReads("host", ["a.service"], revision), {
    initialProps: { revision: 0 },
  });
  invalidateSystemdReads("host");
  api.inspectSystemdUnit.mockResolvedValueOnce(
    systemdInspection("a.service", { Result: "success" }),
  );
  hook.rerender({ revision: 1 });
  await waitFor(() =>
    expect(hook.result.current["a.service"]?.value?.properties.Result).toBe("success"),
  );
  await act(async () => finish(systemdInspection("a.service", { Result: "old" })));
  hook.unmount();
  const next = renderHook(() => useSystemdReads("host", ["a.service"], 0));
  await waitFor(() =>
    expect(next.result.current["a.service"]?.value?.properties.Result).toBe("success"),
  );
});
