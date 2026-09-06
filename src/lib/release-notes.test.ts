import { describe, expect, it } from "vitest";
import { parseReleaseNotes, releaseNotesAreEmpty } from "./release-notes";

describe("release notes parsing", () => {
  it("keeps headings, bullets, and paragraphs apart", () => {
    const blocks = parseReleaseNotes(
      ["## Added", "- Local terminals", "- Split panes", "", "Some closing prose."].join("\n"),
    );
    expect(blocks).toEqual([
      { kind: "heading", text: "Added" },
      { kind: "bullets", items: ["Local terminals", "Split panes"] },
      { kind: "paragraph", text: "Some closing prose." },
    ]);
  });

  it("treats a short label ending in a colon as a heading", () => {
    // The shape generated release notes usually take.
    expect(parseReleaseNotes("Fixed:\n- A crash")).toEqual([
      { kind: "heading", text: "Fixed" },
      { kind: "bullets", items: ["A crash"] },
    ]);
  });

  it("accepts the bullet characters notes actually use", () => {
    expect(parseReleaseNotes("* one\n+ two\n• three")).toEqual([
      { kind: "bullets", items: ["one", "two", "three"] },
    ]);
  });

  it("joins wrapped prose into one paragraph", () => {
    expect(parseReleaseNotes("a line\nand its continuation")).toEqual([
      { kind: "paragraph", text: "a line and its continuation" },
    ]);
  });

  it("shows a link as text rather than making it clickable", () => {
    // A clickable target built from remote text is a phishing surface, and the
    // popover has no business opening a browser on the user's behalf.
    expect(parseReleaseNotes("- See [the docs](https://example.com/x)")).toEqual([
      { kind: "bullets", items: ["See the docs (https://example.com/x)"] },
    ]);
  });

  it("compacts a GitHub pull URL to its number", () => {
    expect(
      parseReleaseNotes(
        "- fix: a thing by @someone in https://github.com/someone/some-repo/pull/53",
      ),
    ).toEqual([{ kind: "bullets", items: ["fix: a thing by @someone in #53"] }]);
  });

  it("compacts a GitHub issue URL like a pull URL", () => {
    expect(parseReleaseNotes("- Fixes https://github.com/someone/some-repo/issues/12")).toEqual([
      { kind: "bullets", items: ["Fixes #12"] },
    ]);
  });

  it("compacts a GitHub compare URL to its range", () => {
    expect(
      parseReleaseNotes(
        "**Full Changelog**: https://github.com/someone/some-repo/compare/v0.7.0...v0.7.1",
      ),
    ).toEqual([{ kind: "paragraph", text: "Full Changelog: v0.7.0 → v0.7.1" }]);
  });

  it("leaves sentence punctuation glued to a compacted URL in place", () => {
    expect(parseReleaseNotes("See https://github.com/someone/some-repo/pull/53.")).toEqual([
      { kind: "paragraph", text: "See #53." },
    ]);
  });

  it("strips the inline markers that survive into generated notes", () => {
    expect(parseReleaseNotes("- **bold** and `code` and _quiet_")).toEqual([
      { kind: "bullets", items: ["bold and code and quiet"] },
    ]);
  });

  it("leaves unknown and non-GitHub URLs as they arrived", () => {
    const line = "- Hosted at https://example.com/pull/53 and https://github.com/someone";
    expect(parseReleaseNotes(line)).toEqual([
      {
        kind: "bullets",
        items: ["Hosted at https://example.com/pull/53 and https://github.com/someone"],
      },
    ]);
  });

  it("never turns release-note text into markup", () => {
    // The parser only ever emits text. Nothing downstream may pass this to
    // dangerouslySetInnerHTML, and this locks in that the tags survive as
    // characters rather than being interpreted or silently dropped.
    const hostile = '<script>alert(1)</script>\n- <img src=x onerror="alert(2)">';
    const blocks = parseReleaseNotes(hostile);
    expect(blocks).toEqual([
      { kind: "paragraph", text: "<script>alert(1)</script>" },
      { kind: "bullets", items: ['<img src=x onerror="alert(2)">'] },
    ]);
  });

  it("keeps even a URL crafted to look like markup inert", () => {
    // Compaction produces text, and text is all it can ever produce: the
    // result still renders as characters, not elements.
    expect(parseReleaseNotes("https://github.com/a/b/compare/<script>...alert(1)")).toEqual([
      { kind: "paragraph", text: "<script> → alert(1)" },
    ]);
  });

  it("renders the notes GitHub actually generates", () => {
    // The verbatim body of the v0.7.1 release. Generated notes are the real
    // input to this parser, so their shape is worth pinning: a heading, one
    // bullet per merged PR with a bare URL, and a bold changelog line — with
    // the GitHub URLs compacted to short text.
    const generated = [
      "## What's Changed",
      "* fix: streamline terminal creation and clipboard UX by @YounesCodes in https://github.com/YounesCodes/control-room/pull/53",
      "",
      "",
      "**Full Changelog**: https://github.com/YounesCodes/control-room/compare/v0.7.0...v0.7.1",
    ].join("\n");

    expect(parseReleaseNotes(generated)).toEqual([
      { kind: "heading", text: "What's Changed" },
      {
        kind: "bullets",
        items: ["fix: streamline terminal creation and clipboard UX by @YounesCodes in #53"],
      },
      { kind: "paragraph", text: "Full Changelog: v0.7.0 → v0.7.1" },
    ]);
  });

  it("treats missing or blank notes as nothing to show", () => {
    expect(parseReleaseNotes(null)).toEqual([]);
    expect(parseReleaseNotes("")).toEqual([]);
    expect(parseReleaseNotes("   \n\n  ")).toEqual([]);
    expect(releaseNotesAreEmpty(null)).toBe(true);
    expect(releaseNotesAreEmpty("- something")).toBe(false);
  });

  it("bounds a note that arrives absurdly long", () => {
    const blocks = parseReleaseNotes(
      Array.from({ length: 500 }, (_, index) => `- item ${index}`).join("\n"),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("bullets");
    expect(blocks[0].kind === "bullets" && blocks[0].items).toHaveLength(200);

    const long = parseReleaseNotes("x".repeat(2000));
    expect(long[0].kind === "paragraph" && long[0].text.length).toBe(500);
  });

  it("handles Windows line endings", () => {
    expect(parseReleaseNotes("# Title\r\n- one\r\n")).toEqual([
      { kind: "heading", text: "Title" },
      { kind: "bullets", items: ["one"] },
    ]);
  });
});
