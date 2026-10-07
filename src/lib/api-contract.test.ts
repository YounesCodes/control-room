import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaselineProgress } from "../types";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage: unknown;
  },
}));
import { Channel } from "@tauri-apps/api/core";
import { api, REMOTE_INSPECTION_TIMEOUT_MS } from "./api";

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("IPC data and lifetime contracts", () => {
  it("sends the exact UTF-8 bytes including NUL and non-ASCII input", async () => {
    const data = new TextEncoder().encode("é سلام\u0000\r\n");
    await api.writeSession("session-a", data);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("write_session", {
      sessionId: "session-a",
      data: Array.from(data),
    });
    expect(new TextDecoder().decode(new Uint8Array(invoke.mock.calls[0][1].data))).toBe(
      "é سلام\u0000\r\n",
    );
  });
  it("passes a terminal output channel without serializing or replacing it", async () => {
    const output = new Channel<ArrayBuffer>();
    await api.startLocalSession("command-prompt", 120, 40, output);
    expect(invoke.mock.calls[0][1].output).toBe(output);
    expect(invoke).toHaveBeenCalledWith("start_local_session", {
      shellId: "command-prompt",
      cols: 120,
      rows: 40,
      output,
    });
  });
  it("keeps baseline progress channels and cancellation IDs intact", async () => {
    const progress = new Channel<BaselineProgress>();
    const request = { connectionId: "host", captureId: "capture", label: null, sections: null };
    await api.captureHostBaseline(request, progress);
    await api.cancelHostBaseline("capture");
    expect(invoke.mock.calls[0][1].progress).toBe(progress);
    expect(invoke).toHaveBeenLastCalledWith("cancel_host_baseline", { captureId: "capture" });
  });
  it("uses bounded history defaults and preserves an explicit search limit", async () => {
    await api.history("host");
    expect(invoke).toHaveBeenLastCalledWith("get_history", {
      connectionId: "host",
      search: "",
      limit: 500,
    });
    await api.history("host", "docker ps", 25);
    expect(invoke).toHaveBeenLastCalledWith("get_history", {
      connectionId: "host",
      search: "docker ps",
      limit: 25,
    });
  });
  it("keeps a one-shot sudo password confined to its requested operation", async () => {
    await api.listPorts("host", "test-password");
    await api.listPorts("host");
    expect(invoke.mock.calls[0][1].sudoPassword).toBe("test-password");
    expect(invoke.mock.calls[1][1].sudoPassword).toBeNull();
  });
  it("clears inspection timers after success and retains the backend error after failure", async () => {
    invoke.mockResolvedValueOnce([{ id: "ssh.service" }]);
    expect(await api.listServices("host")).toEqual([{ id: "ssh.service" }]);
    expect(vi.getTimerCount()).toBe(0);
    const reason = { category: "permission", message: "Authorization failed" };
    invoke.mockRejectedValueOnce(reason);
    await expect(api.inspectFirewall("host")).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not let an expired request's late completion affect a subsequent request", async () => {
    let finish!: (result: unknown) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = api.listServices("host").catch((error) => error.message);
    await vi.advanceTimersByTimeAsync(REMOTE_INSPECTION_TIMEOUT_MS);
    expect(await first).toMatch(/did not respond/);
    invoke.mockResolvedValueOnce([{ id: "current.service" }]);
    const next = await api.listServices("host");
    finish([{ id: "old.service" }]);
    await Promise.resolve();
    expect(next).toEqual([{ id: "current.service" }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
