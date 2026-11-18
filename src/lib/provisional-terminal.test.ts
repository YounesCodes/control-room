import { describe, expect, it } from "vitest";
import {
  provisionalChoice,
  provisionalDiscovery,
  provisionalSessionState,
  startProvisional,
  type ProvisionalStep,
  type ProvisionalTerminal,
} from "./provisional-terminal";
import type { RemoteShellCatalog } from "../types";

const catalog = (platform: RemoteShellCatalog["platform"]): RemoteShellCatalog => ({
  platform,
  shells: platform === "linux" ? [] : [{ id: "cmd", label: "Command Prompt" }],
  windowsTerminalAvailable: false,
  wslError: null,
  capabilities: null,
  profileError: null,
});

function next(step: ProvisionalStep): ProvisionalTerminal {
  if (step.kind !== "keep" && step.kind !== "choose")
    throw new Error(`Expected a state, got ${step.kind}`);
  return step.next;
}

describe("provisional terminal for a host with no saved platform", () => {
  it("starts hidden and reveals a Linux shell once discovery answers", () => {
    const tab = startProvisional();
    expect(tab.concealed).toBe(true);
    expect(provisionalDiscovery(tab, catalog("linux"))).toEqual({ kind: "reveal" });
  });

  it("reveals the default shell when discovery fails, so the tab can show its own state", () => {
    expect(provisionalDiscovery(startProvisional(), null)).toEqual({ kind: "reveal" });
  });

  it("shows a working shell as soon as it connects, then still offers the Mac chooser", () => {
    const connected = next(provisionalSessionState(startProvisional(), "connected"));
    expect(connected).toMatchObject({ concealed: false, shellConnected: true });
    const choosing = provisionalDiscovery(connected, catalog("macos"));
    expect(choosing.kind).toBe("choose");
    expect(provisionalChoice(next(choosing), "cancel")).toEqual({ kind: "reveal" });
  });

  it("never reveals a shell that ended before connecting, and opens the chooser at once", () => {
    const choosing = provisionalSessionState(startProvisional(), "error");
    expect(choosing).toEqual({
      kind: "choose",
      next: { phase: "choosing", concealed: true, shellConnected: false },
    });
    expect(provisionalDiscovery(next(choosing), catalog("windows"))).toEqual({
      kind: "keep",
      next: next(choosing),
    });
    expect(provisionalChoice(next(choosing), "cancel")).toEqual({ kind: "close" });
  });

  it("keeps the tab hidden while it is replaced, then reveals the chosen shell", () => {
    const choosing = next(provisionalDiscovery(startProvisional(), catalog("windows")));
    const replacing = next(provisionalChoice(choosing, "shell"));
    expect(replacing).toMatchObject({ phase: "replacing", concealed: true });
    expect(provisionalSessionState(replacing, "connecting")).toEqual({
      kind: "keep",
      next: replacing,
    });
    expect(provisionalSessionState(replacing, "error")).toEqual({ kind: "reveal" });
    expect(provisionalSessionState(replacing, "connected")).toEqual({ kind: "reveal" });
  });

  it("keeps a connected default shell when the chooser asks for the default", () => {
    const connected = next(provisionalSessionState(startProvisional(), "connected"));
    const choosing = next(provisionalDiscovery(connected, catalog("macos")));
    expect(provisionalChoice(choosing, "default")).toEqual({ kind: "reveal" });
    const ended = next(provisionalSessionState(choosing, "disconnected"));
    expect(provisionalChoice(ended, "default").kind).toBe("keep");
  });

  it("ignores discovery that answers after the chooser has already opened", () => {
    const choosing = next(provisionalSessionState(startProvisional(), "error"));
    expect(provisionalDiscovery(choosing, catalog("linux"))).toEqual({
      kind: "keep",
      next: choosing,
    });
  });
});
