import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync }));
import { recordDrivers } from "../e2e/driver-processes";
afterEach(() => vi.restoreAllMocks());
describe("driver process snapshots", () => {
  it.each(["", "null", "[]", "{}", "invalid-json", "throws"])(
    "does not fail run setup on %s",
    (output) => {
      const directory = mkdtempSync(join(tmpdir(), "control-room-driver-test-"));
      vi.spyOn(console, "error").mockImplementation(() => {});
      execFileSync.mockImplementation(() => {
        if (output === "throws") throw new Error("missing powershell");
        return output;
      });
      try {
        expect(() => recordDrivers(directory, 10)).not.toThrow();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it("normalizes a single owned process into an array", () => {
    const directory = mkdtempSync(join(tmpdir(), "control-room-driver-test-"));
    const driver = { id: 20, parent: 10, name: "tauri-driver.exe", created: "today" };
    execFileSync.mockReturnValue(JSON.stringify(driver));
    try {
      recordDrivers(directory, 10);
      expect(JSON.parse(readFileSync(join(directory, "driver-pids.jsonl"), "utf8"))).toEqual([
        driver,
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
