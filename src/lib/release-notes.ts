export type ReleaseNoteBlock =
  | { kind: "heading"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "paragraph"; text: string };

const MAX_LINES = 200;
const MAX_LINE_LENGTH = 500;

function flattenLinks(line: string): string {
  return line.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (_match, label: string, url: string) => {
    const text = label.trim();
    if (!url) return text;
    return text ? `${text} (${url})` : url;
  });
}

function stripInlineMarkers(line: string): string {
  return line
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*]+)\*/g, "$1$2")
    .replace(/(^|\s)_([^_]+)_/g, "$1$2");
}

function compactGitHubUrls(line: string): string {
  return line.replace(/https:\/\/github\.com\/\S+/g, (raw) => {
    const url = raw.replace(/[.,;:!?)\]}'"]+$/, "");
    const tail = raw.slice(url.length);
    const pull = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/(\d+)$/.exec(url);
    if (pull) return `#${pull[1]}${tail}`;
    const compare = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/compare\/(.+)\.\.\.(.+)$/.exec(url);
    if (compare) return `${compare[1]} → ${compare[2]}${tail}`;
    return raw;
  });
}

function compactGeneratedContribution(line: string): string {
  const contribution = /\s+by\s+@\S+\s+in\s+(#\d+)\s*$/i.exec(line);
  if (!contribution) return line;
  const title = line
    .slice(0, contribution.index)
    .replace(/^(?:feat|fix|docs|refactor|perf|test|build|ci|chore)(?:\([^)]+\))?!?:\s*/i, "")
    .trim();
  if (!title) return contribution[1];
  return `${title[0]?.toUpperCase() ?? ""}${title.slice(1)} (${contribution[1]})`;
}

function clean(line: string): string {
  return compactGeneratedContribution(compactGitHubUrls(stripInlineMarkers(flattenLinks(line))))
    .slice(0, MAX_LINE_LENGTH)
    .trimEnd();
}

const BULLET = /^\s{0,3}([-*+•])\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;

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

export function releaseNotesAreEmpty(notes: string | null | undefined): boolean {
  return parseReleaseNotes(notes).length === 0;
}
