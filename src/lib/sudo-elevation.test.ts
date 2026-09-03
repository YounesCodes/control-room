import { describe, expect, it } from "vitest";
import {
  connectionElevationSource,
  elevationAllowed,
  elevationCapabilityNote,
  elevationSource,
  elevationSummary,
  perHostControlLocked,
} from "./sudo-elevation";
import type { AppSettings, SavedConnection } from "../types";

const connection: SavedConnection = {
  id: "connection-id",
  displayName: "Server",
  destination: "server",
  username: "user",
  port: null,
  identityFile: null,
  historyEnabled: false,
  sudoEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

const settings = { globalSudoEnabled: false } as AppSettings;

describe("sudo elevation", () => {
  it("treats the global setting as an override, not a default", () => {
    expect(elevationSource(true, false)).toBe("global");
    expect(elevationSource(true, true)).toBe("global");
    expect(elevationSource(false, true)).toBe("connection");
    expect(elevationSource(false, false)).toBe("off");
  });

  it("allows elevation from either source", () => {
    expect(elevationAllowed(true, false)).toBe(true);
    expect(elevationAllowed(false, true)).toBe(true);
    expect(elevationAllowed(false, false)).toBe(false);
  });

  it("locks the per-host control only while the global setting is on", () => {
    expect(perHostControlLocked(true)).toBe(true);
    expect(perHostControlLocked(false)).toBe(false);
  });

  it("explains a locked control by naming the global setting", () => {
    expect(elevationSummary("global")).toContain("every Saved Connection");
  });

  it("says one-shot elevation is still available when nothing is allowed", () => {
    expect(elevationSummary("off")).toContain("one request at a time");
  });

  it("keeps an unread capability distinct from a known lack of passwordless sudo", () => {
    expect(elevationCapabilityNote(null)).toBeNull();
    expect(elevationCapabilityNote(true)).toContain("has passwordless sudo");
    expect(elevationCapabilityNote(false)).toContain("asked for a password");
  });

  it("says an allowance without passwordless sudo still runs unelevated", () => {
    // The confusing case is a permission the account cannot act on, so the note
    // has to name the fallback rather than imply the reads are elevated.
    expect(elevationCapabilityNote(false)).toContain("connecting account");
  });

  it("reads the source from a Saved Connection and the saved settings", () => {
    expect(connectionElevationSource(settings, connection)).toBe("off");
    expect(connectionElevationSource(settings, { ...connection, sudoEnabled: true })).toBe(
      "connection",
    );
    expect(connectionElevationSource({ ...settings, globalSudoEnabled: true }, connection)).toBe(
      "global",
    );
  });
});
