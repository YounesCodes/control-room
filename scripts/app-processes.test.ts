import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync }));
import { recordApplication, waitForRecordedApplications } from "../e2e/app-processes";

let directory: string;
const original = {
  id: process.pid,
  created: "2026-10-27T10:00:00.000Z",
  executable: "C:\\tests\\control-room.exe",
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "control-room-app-test-"));
  writeFileSync(join(directory, "app-processes.jsonl"), `${JSON.stringify(original)}\n`);
  execFileSync.mockReset();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it("ignores a reused PID belonging to a later application instance", async () => {
  execFileSync.mockReturnValue(
    JSON.stringify([{ ...original, created: "2026-10-27T10:01:00.000Z" }]),
  );
  await expect(waitForRecordedApplications(directory, 0)).resolves.toBeUndefined();
});

it("still fails and preserves records when the original test app is alive", async () => {
  execFileSync.mockReturnValue(JSON.stringify([original]));
  await expect(waitForRecordedApplications(directory, 0)).rejects.toThrow("is still running");
  expect(readFileSync(join(directory, "app-processes.jsonl"), "utf8")).toContain(original.created);
});

it("records process creation time and executable identity", () => {
  execFileSync.mockReturnValue(JSON.stringify([original]));
  recordApplication(directory, original.id, original.executable);
  const records = readFileSync(join(directory, "app-processes.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/);
  expect(JSON.parse(records[1])).toEqual(original);
});

it("ignores a reused PID with a different executable", async () => {
  execFileSync.mockReturnValue(
    JSON.stringify([{ ...original, executable: "C:\\other\\control-room.exe" }]),
  );
  await expect(waitForRecordedApplications(directory, 0)).resolves.toBeUndefined();
});

it("accepts an empty process snapshot after the test app exits", async () => {
  execFileSync.mockReturnValue("[]");
  await expect(waitForRecordedApplications(directory, 0)).resolves.toBeUndefined();
});

it("preserves data when process inspection fails", async () => {
  execFileSync.mockImplementation(() => {
    throw new Error("CIM unavailable");
  });
  await expect(waitForRecordedApplications(directory, 0)).rejects.toThrow("CIM unavailable");
  expect(readFileSync(join(directory, "app-processes.jsonl"), "utf8")).toContain(original.created);
});

it("refuses to record an app whose executable does not match the test binary", () => {
  execFileSync.mockReturnValue(JSON.stringify([original]));
  expect(() => recordApplication(directory, original.id, "C:\\other\\control-room.exe")).toThrow(
    "Could not verify",
  );
});

it.each(["null", "{}", "invalid-json", '[{"id":12,"created":"now","executable":null}]'])(
  "fails closed on an invalid process snapshot: %s",
  async (snapshot) => {
    execFileSync.mockReturnValue(snapshot);
    await expect(waitForRecordedApplications(directory, 0)).rejects.toThrow();
  },
);
