// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearScratchpadDraft,
  quiesceScratchpad,
  readScratchpadDraft,
  registerScratchpadQuiesce,
  resumeScratchpad,
  writeScratchpadDraft,
} from "./scratchpad-draft";

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});
describe("Scratchpad recovery and deletion coordination", () => {
  it("isolates connection and global drafts and clears only their owner", () => {
    writeScratchpadDraft("connection", "host-a", "A");
    writeScratchpadDraft("connection", "host-b", "B");
    writeScratchpadDraft("global", "global", "G");
    clearScratchpadDraft("connection", "host-a");
    expect(readScratchpadDraft("connection", "host-a")).toBeNull();
    expect(readScratchpadDraft("connection", "host-b")).toBe("B");
    expect(readScratchpadDraft("global", "global")).toBe("G");
  });
  it("reports blocked storage as unavailable without throwing", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Disabled");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Disabled");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("Disabled");
    });
    expect(writeScratchpadDraft("global", "global", "text")).toBe(false);
    expect(readScratchpadDraft("global", "global")).toBeNull();
    expect(() => clearScratchpadDraft("global", "global")).not.toThrow();
  });
  it("waits for a pending save before allowing deletion and resumes after failure", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const coordinator = { quiesce: vi.fn(() => pending), resume: vi.fn() };
    const unregister = registerScratchpadQuiesce("connection", "host-a", coordinator);
    let done = false;
    const waiting = quiesceScratchpad("connection", "host-a").then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    finish();
    await waiting;
    resumeScratchpad("connection", "host-a");
    expect(coordinator.resume).toHaveBeenCalledOnce();
    unregister();
  });
  it("does not unregister a replacement editor when an old editor unmounts", async () => {
    const old = registerScratchpadQuiesce("global", "global", {
      quiesce: vi.fn(),
      resume: vi.fn(),
    });
    const replacement = { quiesce: vi.fn(async () => undefined), resume: vi.fn() };
    const unregister = registerScratchpadQuiesce("global", "global", replacement);
    old();
    await quiesceScratchpad("global", "global");
    expect(replacement.quiesce).toHaveBeenCalledOnce();
    unregister();
    await quiesceScratchpad("global", "global");
    expect(replacement.quiesce).toHaveBeenCalledOnce();
  });
});
