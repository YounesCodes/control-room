/// <reference types="node" />

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(() => new Promise<never>(() => undefined)),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke,
}));

import { api, REMOTE_INSPECTION_TIMEOUT_MS, REMOTE_DISCOVERY_TIMEOUT_MS } from "./api";
import { hostProcessing } from "./host-processing";

const remoteSource = readFileSync(
  new URL("../../src-tauri/src/remote.rs", import.meta.url),
  "utf8",
);

/** Seconds from a `const NAME: Duration = Duration::from_secs(N);` line. */
function rustTimeoutSeconds(name: string): number {
  const match = remoteSource.match(
    new RegExp(`const ${name}: Duration = Duration::from_secs\\((\\d+)\\)`),
  );
  if (!match) throw new Error(`Missing Rust constant ${name}`);
  return Number(match[1]);
}

/// Room left above Rust's nominal budget for process spawn, the kill, wait and
/// reader-thread joins `run_ssh` performs after a command timeout, and
/// scheduling. That cleanup has no bound of its own, so the backstop keeps a
/// deliberate margin rather than trusting it to be instant.
const CLEANUP_SLACK_SECONDS = 6;

describe("structured discovery timeout budget", () => {
  it("allows both platform discovery attempts plus queueing and cleanup", () => {
    expect(REMOTE_DISCOVERY_TIMEOUT_MS / 1000).toBeGreaterThanOrEqual(
      2 * rustTimeoutSeconds("COMMAND_TIMEOUT") +
        rustTimeoutSeconds("MAX_STRUCTURED_QUEUE_WAIT") +
        CLEANUP_SLACK_SECONDS,
    );
  });
  // The frontend guard is a backstop, not the policy. If Rust's budget ever
  // grows past it, every slow inspection reports the generic timeout below
  // instead of the classified failure Rust produces, and the reason is lost.
  // `MAX_STRUCTURED_QUEUE_WAIT` is a total queue bound, enforced against one
  // deadline in `acquire_for`, so this sum is a real maximum.
  it("clears the queue wait plus command timeout Rust allows, with slack", () => {
    const budgetSeconds =
      rustTimeoutSeconds("MAX_STRUCTURED_QUEUE_WAIT") + rustTimeoutSeconds("COMMAND_TIMEOUT");

    expect(budgetSeconds).toBeGreaterThan(0);
    expect(REMOTE_INSPECTION_TIMEOUT_MS / 1000).toBeGreaterThanOrEqual(
      budgetSeconds + CLEANUP_SLACK_SECONDS,
    );
  });
});

describe("structured discovery timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps discovery pending beyond a single inspection budget", async () => {
    let resolved = false;
    const result = api.refreshCapabilities("connection-id").catch((error: Error) => {
      resolved = true;
      return error.message;
    });
    await vi.advanceTimersByTimeAsync(REMOTE_INSPECTION_TIMEOUT_MS);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(REMOTE_DISCOVERY_TIMEOUT_MS - REMOTE_INSPECTION_TIMEOUT_MS);
    expect(await result).toBe("Remote discovery did not respond after 60 seconds");
  });

  it.each([null, "connection-id"])(
    "names a stalled header reading correctly for target %s",
    async (connectionId) => {
      const result = api
        .sampleHeaderMetrics(connectionId, ["cpu"])
        .catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(REMOTE_INSPECTION_TIMEOUT_MS);
      expect(await result).toBe(
        `Host metrics did not respond after ${REMOTE_INSPECTION_TIMEOUT_MS / 1000} seconds`,
      );
      expect(invoke).toHaveBeenCalledWith("sample_header_metrics", {
        connectionId,
        metrics: ["cpu"],
      });
    },
  );

  it("does not advertise a background header reading as active host work", async () => {
    const pending = api.sampleHeaderMetrics("idle-host", ["cpu"]).catch(() => undefined);
    const busyWhileReading = hostProcessing.getSnapshot().has("idle-host");
    await vi.advanceTimersByTimeAsync(REMOTE_INSPECTION_TIMEOUT_MS);
    await pending;
    expect(busyWhileReading).toBe(false);
  });

  it.each([
    ["services", () => api.listServices("connection-id")],
    ["Docker containers", () => api.listContainers("connection-id")],
    ["listening ports", () => api.listPorts("connection-id")],
    ["Docker container details", () => api.inspectContainer("connection-id", "a".repeat(64))],
  ])("turns a stalled %s request into an actionable error", async (_label, request) => {
    const result = request().then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(hostProcessing.getSnapshot().has("connection-id")).toBe(true);

    await vi.advanceTimersByTimeAsync(REMOTE_INSPECTION_TIMEOUT_MS);

    expect(await Promise.race([result, Promise.resolve("still pending")])).toBe(
      `Remote inspection did not respond after ${REMOTE_INSPECTION_TIMEOUT_MS / 1000} seconds`,
    );
    expect(hostProcessing.getSnapshot().has("connection-id")).toBe(false);
  });
});
