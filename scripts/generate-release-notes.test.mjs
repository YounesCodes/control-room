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
    ).toBe("* Add administrator terminals and fix narrow layouts");
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

  it("makes one list without generated headings, credits, or a non-clickable changelog", () => {
    const generated =
      "## What's Changed\n* Fix a crash by @someone in https://github.com/example/app/pull/12\n\n**Full Changelog**: https://example.com";
    expect(
      combineReleaseNotes(generated, [
        { sha: "abc1234", subject: "feat: add a terminal", pullRequests: [] },
      ]),
    ).toBe("* Fix a crash (#12)\n* Add a terminal");
  });

  it("does not repeat a direct change already described by a pull request", () => {
    const generated =
      "## What's Changed\n* Group terminal splits in focus mode by @someone in https://github.com/example/app/pull/81";
    expect(
      combineReleaseNotes(generated, [
        { sha: "one", subject: "fix: group split tabs and update rustls", pullRequests: [] },
        { sha: "two", subject: "fix: simplify focused terminal split headers", pullRequests: [] },
      ]),
    ).toBe("* Group terminal splits in focus mode (#81)\n* Simplify focused terminal split headers");
  });

  it("hides dependency noise, but describes a maintenance-only release", () => {
    const generated =
      "## What's Changed\n* Bump uuid from 1.26.0 to 1.26.1 by @dependabot in https://github.com/example/app/pull/77\n\n## New Contributors\n* @someone made their first contribution in https://github.com/example/app/pull/77\n\n**Full Changelog**: https://example.com";
    expect(combineReleaseNotes(generated, [])).toBe("* Dependency maintenance");
    expect(
      combineReleaseNotes(generated, [
        { sha: "three", subject: "fix: restore terminal search", pullRequests: [] },
      ]),
    ).toBe("* Restore terminal search");
    expect(
      combineReleaseNotes("", [
        { sha: "four", subject: "chore(deps): bump rustls", pullRequests: [] },
      ]),
    ).toBe("* Dependency maintenance");
  });

  it("deduplicates repeated PR titles but keeps distinct actions on the same feature", () => {
    expect(
      combineReleaseNotes(
        "## What's Changed\n* Add terminal search by @one in https://github.com/example/app/pull/90\n* Add terminal search by @two in https://github.com/example/app/pull/91\n* Fix terminal search by @two in https://github.com/example/app/pull/92",
        [],
      ),
    ).toBe("* Add terminal search (#90)\n* Fix terminal search (#92)");
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
