import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, readReleaseNotes } from "./generate-release-notes.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

let directory;
const notes = "- Find terminals faster.\r\n- Fixed a connection issue.\r\n";
const release = { databaseId: 159, tagName: "v1.2.3", isDraft: true, body: notes };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "control-room-release-"));
  vi.stubEnv("GITHUB_REF_NAME", "v1.2.3");
  vi.stubEnv("GITHUB_OUTPUT", join(directory, "output"));
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify(release));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("release notes workflow", () => {
  it("selects the authored GitHub draft without a versioned notes file", () => {
    expect(readReleaseNotes("v1.2.3")).toEqual(release);
    main([]);
    expect(execFileSync).toHaveBeenCalledWith(
      "gh",
      ["release", "view", "v1.2.3", "--json", "databaseId,tagName,isDraft,body"],
      { encoding: "utf8", stdio: "pipe" },
    );
    expect(readFileSync(join(directory, "output"), "utf8")).toBe("id=159\n");
  });

  it("rejects missing releases and invalid tags", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("release not found");
    });
    expect(() => main([])).toThrow(/draft release/);
    vi.stubEnv("GITHUB_REF_NAME", "../other");
    expect(() => main([])).toThrow(/must be a release tag/);
  });

  it("rejects empty notes, another tag, published releases, and invalid release IDs before building", () => {
    for (const candidate of [
      { ...release, body: " \r\n" },
      { ...release, body: null },
      { ...release, tagName: "v1.2.4" },
      { ...release, isDraft: false },
      { ...release, databaseId: null },
    ]) {
      vi.mocked(execFileSync).mockReturnValue(JSON.stringify(candidate));
      expect(() => main([])).toThrow();
    }
  });

  it("copies the exact current release body into the feed and preserves updater metadata", () => {
    const path = join(directory, "latest.json");
    const feed = { version: "1.2.3", platforms: { "windows-x86_64": { signature: "signed" } } };
    writeFileSync(path, JSON.stringify(feed));
    main(["--sync-feed", path]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...feed, notes });
    expect(() => main(["--validate-feed", path])).not.toThrow();
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ ...release, isDraft: false }));
    expect(() => main(["--validate-feed", path])).not.toThrow();
  });

  it("rejects mismatched notes, non-string notes, and edits made on GitHub after syncing", () => {
    const path = join(directory, "latest.json");
    for (const value of ["Old release notes", [notes], notes.trim(), undefined]) {
      writeFileSync(path, JSON.stringify({ notes: value }));
      expect(() => main(["--validate-feed", path])).toThrow(/do not match/);
    }
    writeFileSync(path, JSON.stringify({ notes }));
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ ...release, body: "Edited notes" }));
    expect(() => main(["--validate-feed", path])).toThrow(/do not match/);
  });

  it("rejects missing feed paths and unknown arguments", () => {
    expect(() => main(["--sync-feed"])).toThrow(/latest.json path/);
    expect(() => main(["--validate-feed"])).toThrow(/latest.json path/);
    expect(() => main(["--unknown"])).toThrow(/Unknown/);
  });
});
