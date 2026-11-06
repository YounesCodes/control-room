import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { expect, it } from "vitest";

it("rejects concurrent sessions and exits after a browser launch failure without keeping the server alive", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const results = path.join(root, "test-results");
  mkdirSync(results, { recursive: true });
  const fixture = mkdtempSync(path.join(results, "ui-review-runtime-"));
  if (path.dirname(fixture) !== results || !path.basename(fixture).startsWith("ui-review-runtime-"))
    throw new Error("Unexpected UI review test directory");
  try {
    for (const file of [
      "scripts/ui-review.mjs",
      "scripts/ui-review-options.mjs",
      "src/test/ui-review/scenarios.json",
    ]) {
      mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      copyFileSync(path.join(root, file), path.join(fixture, file));
    }
    const output = path.join(fixture, "test-results/ui-review");
    mkdirSync(output, { recursive: true });
    const lock = path.join(output, ".lock");
    const run = () =>
      spawnSync(
        process.execPath,
        [path.join(fixture, "scripts/ui-review.mjs"), "capture", "--scenario", "settings"],
        {
          cwd: fixture,
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(fixture, "no-browsers") },
          encoding: "utf8",
          timeout: 20_000,
          windowsHide: true,
        },
      );
    writeFileSync(lock, String(process.pid));
    const occupied = run();
    expect(occupied.error).toBeUndefined();
    expect(occupied.status).toBe(1);
    expect(occupied.stderr).toContain("Another UI review owns");
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
    rmSync(lock);
    const failed = run();
    expect(failed.error).toBeUndefined();
    expect(failed.status).toBe(1);
    expect(existsSync(lock)).toBe(false);
    expect(JSON.parse(readFileSync(path.join(output, "session.json"), "utf8"))).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/Executable doesn.t exist/),
    });
  } finally {
    // Only remove the generated fixture beneath this checkout's ignored results.
    rmSync(fixture, { recursive: true, force: true });
  }
}, 45_000);
