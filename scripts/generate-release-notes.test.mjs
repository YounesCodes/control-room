import { describe, expect, it } from "vitest";
import {
  buildDirectChangeNotes,
  combineReleaseNotes,
  hasDescribedChanges,
} from "./generate-release-notes.mjs";

describe("release note generation", () => {
  it("describes direct changes and omits the release housekeeping commit", () => {
    expect(
      buildDirectChangeNotes([
        {
          sha: "2de5547",
          subject: "feat: add administrator terminals and fix narrow layouts",
          pullRequests: [],
        },
        {
          sha: "19b8672",
          subject: "chore: release v0.7.4",
          pullRequests: [],
        },
      ]),
    ).toBe("## Direct changes\n* Add administrator terminals and fix narrow layouts");
  });

  it("leaves commits with associated pull requests to GitHub generated notes", () => {
    expect(
      buildDirectChangeNotes([
        {
          sha: "05e9b9c",
          subject: "fix: clarify live log and resource state (#69)",
          pullRequests: [69],
        },
      ]),
    ).toBe("");
  });

  it("prepends direct changes without replacing generated pull request notes", () => {
    const generated =
      "## What's Changed\n* Fix a crash by @someone in https://github.com/example/app/pull/12\n\n**Full Changelog**: https://example.com";
    expect(
      combineReleaseNotes(generated, [
        { sha: "abc1234", subject: "feat: add a terminal", pullRequests: [] },
      ]),
    ).toBe(`## Direct changes\n* Add a terminal\n\n${generated}`);
  });

  it("rejects a changelog-only body", () => {
    expect(
      hasDescribedChanges(
        "**Full Changelog**: https://github.com/YounesCodes/control-room/compare/v0.7.3...v0.7.4",
      ),
    ).toBe(false);
  });

  it("accepts generated bullets and hand-written prose", () => {
    expect(
      hasDescribedChanges(
        "## What's Changed\n* Fix updater notes (#74)\n\n**Full Changelog**: https://example.com",
      ),
    ).toBe(true);
    expect(hasDescribedChanges("This release fixes updater notes.")).toBe(true);
  });
});
