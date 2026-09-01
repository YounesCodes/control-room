import type {
  HostDiff,
  HostDiffRow,
  HostDiffSection,
  HostDiffSectionKind,
  HostDiffRowState,
  HostStateStatus,
} from "../types";

const SECTION_LABELS: Record<HostDiffSectionKind, string> = {
  host: "Host facts",
  systemdUnits: "Systemd units",
  listeners: "Listening sockets",
  containers: "Containers",
  filesystems: "Filesystems",
};

const STATUS_LABELS: Record<HostStateStatus, string> = {
  collected: "Collected",
  partial: "Partial",
  unsupported: "Not present",
  unavailable: "Not readable",
  notCollected: "Not collected",
};

const ROW_LABELS: Record<HostDiffRowState, string> = {
  equal: "Same",
  different: "Differs",
  leftOnly: "Left only",
  rightOnly: "Right only",
};

export function sectionLabel(kind: HostDiffSectionKind): string {
  return SECTION_LABELS[kind] ?? kind;
}

export function statusLabel(status: HostStateStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function rowStateLabel(state: HostDiffRowState): string {
  return ROW_LABELS[state] ?? state;
}

export function visibleRows(section: HostDiffSection, differencesOnly: boolean): HostDiffRow[] {
  return differencesOnly ? section.rows.filter((row) => row.state !== "equal") : section.rows;
}

// A section neither host could read contributes nothing to the count. It is
// reported as not comparable instead, so absent evidence never reads as
// agreement.
export function diffSummary(diff: HostDiff): string {
  const comparable = diff.sections.filter((section) => section.comparable);
  const skipped = diff.sections.length - comparable.length;
  const differences = comparable.reduce((total, section) => total + section.differentCount, 0);
  const differenceText = differences === 1 ? "1 difference" : `${differences} differences`;
  if (!skipped) return differenceText;
  const skippedText =
    skipped === 1 ? "1 section could not be compared" : `${skipped} sections could not be compared`;
  return `${differenceText}, ${skippedText}`;
}

// A wide gap between the two collections means the comparison describes two
// different moments, which the reader has to know before trusting it.
export function skewWarning(diff: HostDiff): string | null {
  const skew = diff.collectionSkewSeconds;
  if (skew === null) {
    return "One host never reported a collection time, so the two sides may describe different moments.";
  }
  if (skew > 120) {
    return `The two hosts were read ${formatDuration(skew)} apart. Values that move on their own may differ for that reason alone.`;
  }
  return null;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function formatCollectedAt(value: string | null): string {
  if (!value) return "not collected";
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleTimeString();
}

// Only listener and unit rows lead anywhere: Ports and Systemd take an id that
// this row actually carries. Container and filesystem rows stay read-only here.
export function rowDestination(
  kind: HostDiffSectionKind,
  row: HostDiffRow,
): { view: "services" | "ports"; selectionId: string | null } | null {
  if (kind === "systemdUnits") return { view: "services", selectionId: row.identity };
  if (kind === "listeners") return { view: "ports", selectionId: null };
  return null;
}
