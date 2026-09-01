import type {
  HostSnapshotSummary,
  SnapshotComparison,
  SnapshotSectionDiff,
  SnapshotSectionKind,
  SnapshotSectionStatus,
} from "../types";

const SECTION_LABELS: Record<SnapshotSectionKind, string> = {
  host: "Host facts",
  systemdUnits: "Systemd units",
  containers: "Containers",
  listeners: "Listening sockets",
  filesystems: "Filesystems",
};

const STATUS_LABELS: Record<SnapshotSectionStatus, string> = {
  collected: "Collected",
  partial: "Partial",
  unsupported: "Not present",
  unavailable: "Not readable",
};

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

export function identityWarning(comparison: SnapshotComparison): string | null {
  if (comparison.identityMatch === "different") {
    return "These captures came from different machine identities. Treat the comparison as two hosts, not one host over time.";
  }
  if (comparison.identityMatch === "unknown") {
    return "No machine identity was readable, so Control Room cannot confirm both captures came from the same host.";
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
