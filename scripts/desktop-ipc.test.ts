import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../e2e/helpers";

const browser = vi.hoisted(() => ({
  execute: vi.fn(async (callback, ...args) => callback(...args)),
  waitUntil: vi.fn(),
}));
vi.mock("@wdio/globals", () => ({ browser, $: vi.fn(), expect: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("desktop IPC readiness", () => {
  it("waits for the Tauri bridge before the first native command", async () => {
    const invoke = vi.fn().mockResolvedValue({ appPid: 123 });
    vi.stubGlobal("__TAURI__", undefined);
    browser.waitUntil.mockImplementationOnce(async (ready) => {
      expect(await ready()).toBe(false);
      expect(invoke).not.toHaveBeenCalled();
      vi.stubGlobal("__TAURI__", { core: { invoke } });
      expect(await ready()).toBe(true);
    });

    await expect(ipc("e2e_runtime_status")).resolves.toEqual({ appPid: 123 });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("e2e_runtime_status", {});
  });

  it("reports startup timeouts without invoking a native command", async () => {
    vi.stubGlobal("__TAURI__", undefined);
    browser.waitUntil.mockRejectedValueOnce(new Error("Tauri bridge did not become ready"));
    await expect(ipc("e2e_runtime_status")).rejects.toThrow("Tauri bridge did not become ready");
  });

  it("propagates native command errors without retrying the command", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("Native command failed"));
    vi.stubGlobal("__TAURI__", { core: { invoke } });
    browser.waitUntil.mockImplementationOnce(async (ready) => expect(await ready()).toBe(true));
    await expect(ipc("save_settings", { value: 1 })).rejects.toThrow("Native command failed");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("save_settings", { value: 1 });
  });
});
