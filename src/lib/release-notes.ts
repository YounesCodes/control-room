/**
 * Release notes arrive from GitHub through the updater feed, which makes them
 * text Control Room did not write.
 *
 * They are therefore parsed into a small set of typed blocks and rendered as
 * React text nodes. Nothing here produces HTML, and no caller passes the result
 * to `dangerouslySetInnerHTML`, so a release note containing markup shows the
 * markup as characters instead of running it. That is the whole security model
 * for this file: the notes never stop being data.
 *
 * The formatting understood is the small subset that `--generate-notes` and
 * hand-written notes actually use. Anything else degrades to a paragraph rather
 * than pulling in a Markdown renderer for one panel.
 */

export type ReleaseNoteBlock =
  | { kind: "heading"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "paragraph"; text: string };

/** Caps a hostile or accidentally enormous note before it reaches the DOM. */
const MAX_LINES = 200;
const MAX_LINE_LENGTH = 500;

/**
 * `[label](https://example.com)` becomes `label (https://example.com)`.
 *
 * The URL is kept visible as text rather than becoming a link: a clickable
 * target built from remote text is a phishing surface, and the popover has no
 * business opening a browser on the user's behalf.
 */
function flattenLinks(line: string): string {
  return line.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (_match, label: string, url: string) => {
    const text = label.trim();
    if (!url) return text;
    return text ? `${text} (${url})` : url;
  });
}

/** Strips the emphasis and code markers that survive into generated notes. */
function stripInlineMarkers(line: string): string {
  return line
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*]+)\*/g, "$1$2")
    .replace(/(^|\s)_([^_]+)_/g, "$1$2");
}

function clean(line: string): string {
  return stripInlineMarkers(flattenLinks(line)).slice(0, MAX_LINE_LENGTH).trimEnd();
}

const BULLET = /^\s{0,3}([-*+•])\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;

/**
 * Parses notes into blocks. Returns an empty array for missing or blank notes,
 * which callers show as "no notes" rather than an empty panel.
 */
export function parseReleaseNotes(notes: string | null | undefined): ReleaseNoteBlock[] {
  if (!notes) return [];
  const lines = notes.replace(/\r\n?/g, "\n").split("\n").slice(0, MAX_LINES);

  const blocks: ReleaseNoteBlock[] = [];
  let bullets: string[] = [];
  let paragraph: string[] = [];

  const flushBullets = () => {
    if (bullets.length) {
      blocks.push({ kind: "bullets", items: bullets });
      bullets = [];
    }
  };
  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const flush = () => {
    flushBullets();
    flushParagraph();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const text = clean(heading[2]).trim();
      if (text) blocks.push({ kind: "heading", text });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      const text = clean(bullet[2]).trim();
      if (text) bullets.push(text);
      continue;
    }

    // A "Fixed"-style label followed by a colon reads as a heading even without
    // a leading hash, which is how generated notes usually group changes.
    if (/^[A-Z][A-Za-z ]{0,28}:$/.test(line.trim())) {
      flush();
      blocks.push({ kind: "heading", text: line.trim().replace(/:$/, "") });
      continue;
    }

    flushBullets();
    const text = clean(line).trim();
    if (text) paragraph.push(text);
  }

  flush();
  return blocks;
}

/** True when there is nothing worth showing under "What's new". */
export function releaseNotesAreEmpty(notes: string | null | undefined): boolean {
  return parseReleaseNotes(notes).length === 0;
}
