import { describe, expect, it, vi } from "vitest";
import type { HostCapabilities } from "../types";
import { detectHostCapabilities } from "./host-capabilities";

function capabilities(osId: string): HostCapabilities {
  return {
    connectionId: "connection-1",
    hostname: "host",
    osId,
    osName: osId,
    osVersion: null,
    kernel: null,
    architecture: null,
    uptime: null,
    defaultShell: null,
    systemdAvailable: false,
    journaldAvailable: false,
    dockerAvailable: false,
    dockerAccessible: false,
    dockerAccessibleWithSudo: false,
    passwordlessSudo: false,
    dockerVersion: null,
    runningServiceCount: null,
    runningContainerCount: null,
    totalContainerCount: null,
    detectedAt: "2026-08-23T00:00:00Z",
  };
}

describe("host capability detection", () => {
  it("uses cached host capabilities without another remote probe", async () => {
    const cached = capabilities("debian");
    const capabilitiesApi = {
      cachedCapabilities: vi.fn().mockResolvedValue(cached),
      refreshCapabilities: vi.fn(),
    };

    await expect(detectHostCapabilities(capabilitiesApi, "connection-1")).resolves.toBe(cached);
    expect(capabilitiesApi.refreshCapabilities).not.toHaveBeenCalled();
  });

  it("detects capabilities remotely when a new connection has no cache", async () => {
    const detected = capabilities("ubuntu");
    const capabilitiesApi = {
      cachedCapabilities: vi.fn().mockResolvedValue(null),
      refreshCapabilities: vi.fn().mockResolvedValue(detected),
    };

    await expect(detectHostCapabilities(capabilitiesApi, "connection-1")).resolves.toBe(detected);
    expect(capabilitiesApi.refreshCapabilities).toHaveBeenCalledWith("connection-1");
  });
});
