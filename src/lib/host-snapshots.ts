import type {
  HostSnapshotSummary,
  SnapshotComparison,
  SnapshotEntryChange,
  SnapshotSectionDiff,
  SnapshotSectionKind,
  SnapshotSectionStatus,
} from "../types";

const SECTION_LABELS: Record<SnapshotSectionKind, string> = {
  host: "Host facts",
  systemdUnits: "Systemd units",
  containers: "Containers",
  listeners: "Ports",
  filesystems: "Filesystems",
};

const STATUS_LABELS: Record<SnapshotSectionStatus, string> = {
  collected: "Collected",
  partial: "Partial",
  unsupported: "Not present",
  unavailable: "Not readable",
  skipped: "Not captured",
};

// The chips are one word each, and the difference between them decides whether
// a missing answer is the host's shape or a permission problem.
const STATUS_HINTS: Record<SnapshotSectionStatus, string> = {
  collected: "Control Room read this section in full.",
  partial: "Control Room read this section, but some entries were incomplete.",
  unsupported: "The subsystem is not installed on this host.",
  unavailable: "The subsystem is there, but this account could not read it.",
  skipped: "This capture never asked for this section.",
};

export const SECTION_KINDS: SnapshotSectionKind[] = [
  "host",
  "systemdUnits",
  "containers",
  "listeners",
  "filesystems",
];

// Facts that move on a healthy host. Left in, they bury the changes that matter
// under normal churn, so a comparison hides them until the user asks.
const VOLATILE_FACTS: Partial<Record<SnapshotSectionKind, string[]>> = {
  systemdUnits: ["subState"],
  containers: ["state"],
};

export function statusHint(status: SnapshotSectionStatus): string {
  return STATUS_HINTS[status] ?? "";
}

export function volatileFacts(kind: SnapshotSectionKind): string[] {
  return VOLATILE_FACTS[kind] ?? [];
}

export function hasVolatileChanges(comparison: SnapshotComparison): boolean {
  return comparison.sections.some((section) =>
    section.changed.some((entry) =>
      entry.changes.some((change) => volatileFacts(section.kind).includes(change.name)),
    ),
  );
}

// Dropping a muted fact can empty an entry's change list. Such an entry is
// removed rather than shown as changed with nothing to show.
export function applyVolatileFilter(
  comparison: SnapshotComparison,
  hideVolatile: boolean,
): SnapshotComparison {
  if (!hideVolatile) return comparison;
  return {
    ...comparison,
    sections: comparison.sections.map((section) => {
      const muted = volatileFacts(section.kind);
      if (!muted.length) return section;
      const changed = section.changed
        .map((entry) => ({
          ...entry,
          changes: entry.changes.filter((change) => !muted.includes(change.name)),
        }))
        .filter((entry: SnapshotEntryChange) => entry.changes.length > 0);
      return {
        ...section,
        changed,
        unchangedCount: section.unchangedCount + (section.changed.length - changed.length),
      };
    }),
  };
}

export function sectionLabel(kind: SnapshotSectionKind): string {
  return SECTION_LABELS[kind] ?? kind;
}

export function statusLabel(status: SnapshotSectionStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function snapshotTitle(snapshot: HostSnapshotSummary): string {
  return snapshot.label ?? formatCapturedAt(snapshot.capturedAt);
}

export function formatCapturedAt(value: string): string {
  const captured = new Date(value);
  if (Number.isNaN(captured.getTime())) return value;
  return captured.toLocaleString();
}

export function changeCount(diff: SnapshotSectionDiff): number {
  return diff.added.length + diff.removed.length + diff.changed.length;
}

// A section that could not be compared is never counted as unchanged, so the
// summary line cannot imply a quiet host when evidence is missing.
export function comparisonSummary(comparison: SnapshotComparison): string {
  const comparable = comparison.sections.filter((section) => section.comparable);
  const skipped = comparison.sections.length - comparable.length;
  const changes = comparable.reduce((total, section) => total + changeCount(section), 0);
  const changeText = changes === 1 ? "1 change" : `${changes} changes`;
  if (!skipped) return changeText;
  const skippedText =
    skipped === 1 ? "1 section could not be compared" : `${skipped} sections could not be compared`;
  return `${changeText}, ${skippedText}`;
}

// The live side is read for the comparison and never saved, so it is named for
// what it is rather than shown as another capture in the list.
export const LIVE_COMPARISON_ID = "live";
const LIVE_TARGET_TITLE = "Live state";

export function comparisonTargetTitle(comparison: SnapshotComparison): string {
  return comparison.targetIsLive ? LIVE_TARGET_TITLE : snapshotTitle(comparison.target);
}

export function identityWarning(comparison: SnapshotComparison): string | null {
  if (comparison.identityMatch === "different") {
    return comparison.targetIsLive
      ? "This connection is answering as a different machine than the capture came from. Treat the comparison as two hosts, not one host over time."
      : "These captures came from different machine identities. Treat the comparison as two hosts, not one host over time.";
  }
  if (comparison.identityMatch === "unknown") {
    return comparison.targetIsLive
      ? "No machine identity was readable, so Control Room cannot confirm the live host is the one the capture came from."
      : "No machine identity was readable, so Control Room cannot confirm both captures came from the same host.";
  }
  return null;
}

// Orders newest first and keeps the ordering stable for captures that share a
// timestamp, so the list never reshuffles between reads.
export function sortSnapshots(snapshots: HostSnapshotSummary[]): HostSnapshotSummary[] {
  return [...snapshots].sort((left, right) => {
    if (left.capturedAt === right.capturedAt) return right.id.localeCompare(left.id);
    return right.capturedAt.localeCompare(left.capturedAt);
  });
}

// The comparison always reads earlier to later, whichever row the user picked.
export function orderForComparison(
  selected: HostSnapshotSummary,
  other: HostSnapshotSummary,
): { baseId: string; targetId: string } {
  const selectedIsEarlier =
    selected.capturedAt < other.capturedAt ||
    (selected.capturedAt === other.capturedAt && selected.id < other.id);
  return selectedIsEarlier
    ? { baseId: selected.id, targetId: other.id }
    : { baseId: other.id, targetId: selected.id };
}

// Export writes what the panel shows and nothing more: the same normalized
// facts, already filtered the same way, so a pasted diff matches the screen.
export function comparisonToMarkdown(comparison: SnapshotComparison): string {
  const lines: string[] = [
    `# ${snapshotTitle(comparison.base)} → ${comparisonTargetTitle(comparison)}`,
    "",
    comparisonSummary(comparison),
    "",
  ];
  const warning = identityWarning(comparison);
  if (warning) lines.push(`> ${warning}`, "");
  if (comparison.targetIsLive) {
    lines.push(
      `> Live state read ${formatCapturedAt(comparison.target.capturedAt)}. This read was not saved.`,
      "",
    );
  }
  for (const section of comparison.sections) {
    lines.push(`## ${sectionLabel(section.kind)}`, "");
    lines.push(`${statusLabel(section.baseStatus)} → ${statusLabel(section.targetStatus)}`, "");
    if (!section.comparable) {
      lines.push(section.note ?? "Not comparable.", "");
      continue;
    }
    if (section.note) lines.push(section.note, "");
    const changes = changeCount(section);
    if (!changes) {
      lines.push(`No change across ${section.unchangedCount} compared entries.`, "");
      continue;
    }
    for (const entry of section.added) lines.push(`- Added \`${entry.label}\``);
    for (const entry of section.removed) lines.push(`- Removed \`${entry.label}\``);
    for (const entry of section.changed) {
      lines.push(`- Changed \`${entry.label}\``);
      for (const change of entry.changes) {
        lines.push(
          `  - ${change.name}: \`${change.baseValue ?? "not recorded"}\` → \`${change.targetValue ?? "not recorded"}\``,
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function comparisonToJson(comparison: SnapshotComparison): string {
  return JSON.stringify(comparison, null, 2);
}

// A file name someone can find again a week later, and one no filesystem will
// reject.
export function exportFileName(comparison: SnapshotComparison, extension: string): string {
  const safe = (value: string) =>
    value
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "capture";
  return `snapshot-${safe(snapshotTitle(comparison.base))}-to-${safe(
    comparisonTargetTitle(comparison),
  )}.${extension}`;
}
