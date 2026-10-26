import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./generate-release-notes.mjs", import.meta.url));
let directory;

function run(args = [], tag = "v1.2.3") {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: directory,
    env: { ...process.env, GITHUB_REF_NAME: tag, GITHUB_OUTPUT: join(directory, "output") },
    encoding: "utf8",
    stdio: "pipe",
  });
}

function setup(notes) {
  directory = mkdtempSync(join(tmpdir(), "control-room-release-"));
  mkdirSync(join(directory, "release-notes"));
  if (notes !== undefined) writeFileSync(join(directory, "release-notes", "v1.2.3.txt"), notes);
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("release notes workflow", () => {
  it("writes the authored notes to the release body and accepts the same updater notes", () => {
    const notes = "- Find terminals faster.\n- Fixed a connection issue.";
    setup(`${notes.replace(/\n/g, "\r\n")}\r\n`);
    run();
    expect(readFileSync(join(directory, "output"), "utf8")).toContain(`\n${notes}\n`);
    writeFileSync(join(directory, "latest.json"), JSON.stringify({ notes }));
    expect(() => run(["--validate-feed", "latest.json"])).not.toThrow();
  });

  it("stops when notes are missing, empty, or for a different version", () => {
    setup();
    expect(() => run()).toThrow(/Missing release-notes\/v1\.2\.3\.txt/);
    writeFileSync(join(directory, "release-notes", "v1.2.3.txt"), "  \n");
    expect(() => run()).toThrow(/is empty/);
    writeFileSync(join(directory, "release-notes", "v1.2.3.txt"), "- Fixed a connection issue.");
    expect(() => run([], "v1.2.4")).toThrow(/Missing release-notes\/v1\.2\.4\.txt/);
    expect(() => run([], "../other")).toThrow(/must be a release tag/);
  });

  it("rejects updater notes that do not match the authored release notes", () => {
    setup("- Fixed a connection issue.");
    writeFileSync(join(directory, "latest.json"), JSON.stringify({ notes: "Old release notes" }));
    expect(() => run(["--validate-feed", "latest.json"])).toThrow(/do not match/);
    writeFileSync(join(directory, "latest.json"), JSON.stringify({ notes: ["Not a string"] }));
    expect(() => run(["--validate-feed", "latest.json"])).toThrow(/do not match/);
  });
});
