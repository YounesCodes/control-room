import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(() => new Promise<never>(() => undefined)),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke,
}));

import { api } from "./api";

describe("structured discovery timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["capabilities", () => api.refreshCapabilities("connection-id")],
    ["services", () => api.listServices("connection-id")],
    ["Docker containers", () => api.listContainers("connection-id")],
  ])("turns a stalled %s request into an actionable error", async (_label, request) => {
    const result = request().then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    await vi.advanceTimersByTimeAsync(25_000);

    expect(await Promise.race([result, Promise.resolve("still pending")])).toBe(
      "Remote inspection did not respond after 25 seconds",
    );
  });
});
