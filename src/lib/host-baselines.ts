import type {
  HostBaselineSummary,
  BaselineComparison,
  BaselineEntryChange,
  BaselineSectionDiff,
  BaselineEntry,
  BaselineSectionKind,
  BaselineSectionStatus,
  BaselineFactChange,
} from "../types";

const SECTION_LABELS: Record<BaselineSectionKind, string> = {
  host: "Host facts",
  systemdUnits: "Systemd units",
  containers: "Containers",
  listeners: "Ports",
  firewall: "Firewall",
  filesystems: "Filesystems",
  scheduledJobs: "Scheduled jobs",
  packages: "Packages",
};

const SECTION_SHORT_LABELS: Record<BaselineSectionKind, string> = {
  host: "Host",
  systemdUnits: "Systemd",
  containers: "Containers",
  listeners: "Ports",
  firewall: "Firewall",
  filesystems: "Filesystems",
  scheduledJobs: "Cron",
  packages: "Packages",
};

const STATUS_LABELS: Record<BaselineSectionStatus, string> = {
  collected: "Collected",
  partial: "Partial",
  unsupported: "Not present",
  unavailable: "Not readable",
  skipped: "Not captured",
};

// The chips are one word each, and the difference between them decides whether
// a missing answer is the host's shape or a permission problem.
const STATUS_HINTS: Record<BaselineSectionStatus, string> = {
  collected: "Control Room read this section in full.",
  partial: "Control Room read this section, but some entries were incomplete.",
  unsupported: "The subsystem is not installed on this host.",
  unavailable: "The subsystem is there, but this account could not read it.",
  skipped: "This capture never asked for this section.",
};

export const SECTION_KINDS: BaselineSectionKind[] = [
  "host",
  "systemdUnits",
  "containers",
  "listeners",
  "firewall",
  "filesystems",
  "scheduledJobs",
  "packages",
];

export function statusHint(status: BaselineSectionStatus): string {
  return STATUS_HINTS[status] ?? "";
}

export function isRoutineChange(change: BaselineFactChange): boolean {
  return change.classification === "routine";
}

// An entry whose every changed fact is routine is routine as a whole: it stays
// recorded, but the default view carries it as a count rather than a row.
export function isRoutineEntry(entry: BaselineEntryChange): boolean {
  return entry.changes.length > 0 && entry.changes.every(isRoutineChange);
}

export function meaningfulChangeCount(section: BaselineSectionDiff): number {
  return (
    section.added.length +
    section.removed.length +
    section.changed.filter((entry) => !isRoutineEntry(entry)).length
  );
}

export function entrySearchText(entry: BaselineEntry, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return (
    entry.label.toLowerCase().includes(needle) ||
    entry.facts.some(
      (fact) =>
        fact.name.toLowerCase().includes(needle) || fact.value.toLowerCase().includes(needle),
    )
  );
}

export function changeSearchText(entry: BaselineEntryChange, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return (
    entry.label.toLowerCase().includes(needle) ||
    entry.changes.some(
      (change) =>
        change.name.toLowerCase().includes(needle) ||
        (change.baseValue ?? "").toLowerCase().includes(needle) ||
        (change.targetValue ?? "").toLowerCase().includes(needle) ||
        (change.reason ?? "").toLowerCase().includes(needle),
    )
  );
}

export interface ComparisonViewOptions {
  /** False hides routine churn (the default review); true shows everything. */
  showRoutine: boolean;
  search: string;
}

export interface ComparisonSectionView extends BaselineSectionDiff {
  meaningfulCount: number;
}

/** This view carries both the hidden churn count and the search position, so
 * the summary line, the timeline, and the detail rows can never disagree. */
export function comparisonView(
  comparison: BaselineComparison,
  options: ComparisonViewOptions,
): ComparisonSectionView[] {
  return comparison.sections.map((section) => {
    const meaningfulCount = section.comparable ? meaningfulChangeCount(section) : 0;
    if (!section.comparable) {
      return { ...section, added: [], removed: [], changed: [], meaningfulCount };
    }
    const changed = options.showRoutine
      ? section.changed
      : section.changed.filter((entry) => !isRoutineEntry(entry));
    return {
      ...section,
      added: section.added.filter((entry) => entrySearchText(entry, options.search)),
      removed: section.removed.filter((entry) => entrySearchText(entry, options.search)),
      changed: changed.filter((entry) => changeSearchText(entry, options.search)),
      meaningfulCount,
    };
  });
}

export function comparisonTotals(comparison: BaselineComparison): {
  meaningful: number;
  routine: number;
  incomparable: number;
} {
  const comparable = comparison.sections.filter((section) => section.comparable);
  return {
    meaningful: comparable.reduce((total, section) => total + meaningfulChangeCount(section), 0),
    routine: comparable.reduce((total, section) => total + section.routineCount, 0),
    incomparable: comparison.sections.length - comparable.length,
  };
}

export function sectionLabel(kind: BaselineSectionKind): string {
  return SECTION_LABELS[kind] ?? kind;
}

export function sectionShortLabel(kind: BaselineSectionKind): string {
  return SECTION_SHORT_LABELS[kind] ?? sectionLabel(kind);
}

export function statusLabel(status: BaselineSectionStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function baselineTitle(baseline: HostBaselineSummary): string {
  return baseline.label ?? formatCapturedAt(baseline.capturedAt);
}

export function formatCapturedAt(value: string): string {
  const captured = new Date(value);
  if (Number.isNaN(captured.getTime())) return value;
  return captured.toLocaleString();
}

// A capture's readable coverage, so the timeline node can say how much of the
// host it actually saw without inventing a health verdict.
export function coverageText(baseline: HostBaselineSummary): string {
  const total = baseline.sections.length || SECTION_KINDS.length;
  const read = baseline.sections.filter(
    (section) => section.status === "collected" || section.status === "partial",
  ).length;
  return `${read}/${total} read`;
}

// A section that could not be compared is never counted as unchanged, so the
// summary line cannot imply a quiet host when evidence is missing.
export function comparisonSummary(
  comparison: BaselineComparison,
  options?: ComparisonViewOptions,
): string {
  const { meaningful, routine, incomparable } = comparisonTotals(comparison);
  const showingRoutine = options?.showRoutine ?? false;
  const parts: string[] = [
    meaningful === 1 ? "1 meaningful difference" : `${meaningful} meaningful differences`,
  ];
  if (routine > 0) {
    const noun = routine === 1 ? " routine change" : " routine changes";
    // The counts stay identical in every state; only the claim about where the
    // routine changes go changes with what the view is showing.
    parts.push(showingRoutine ? `${routine}${noun}` : `${routine}${noun} hidden`);
  }
  if (incomparable > 0) {
    parts.push(
      incomparable === 1
        ? "1 section could not be compared"
        : `${incomparable} sections could not be compared`,
    );
  }
  return parts.join(" · ");
}

// The live side is read for the comparison and never saved, so it is named for
// what it is rather than shown as another capture in the list.
export const LIVE_COMPARISON_ID = "live";
const LIVE_TARGET_TITLE = "Live state";

export function comparisonTargetTitle(comparison: BaselineComparison): string {
  return comparison.targetIsLive ? LIVE_TARGET_TITLE : baselineTitle(comparison.target);
}

export function identityWarning(comparison: BaselineComparison): string | null {
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
export function sortBaselines(baselines: HostBaselineSummary[]): HostBaselineSummary[] {
  return [...baselines].sort((left, right) => {
    if (left.capturedAt === right.capturedAt) return right.id.localeCompare(left.id);
    return right.capturedAt.localeCompare(left.capturedAt);
  });
}

// The comparison always reads earlier to later, whichever capture is selected.
export function orderForComparison(
  selected: HostBaselineSummary,
  other: HostBaselineSummary,
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
export function comparisonToMarkdown(
  comparison: BaselineComparison,
  options: ComparisonViewOptions = { showRoutine: true, search: "" },
): string {
  const lines: string[] = [
    `# ${baselineTitle(comparison.base)} → ${comparisonTargetTitle(comparison)}`,
    "",
    comparisonSummary(comparison, options),
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
  if (!comparison.schemaCompatible) {
    lines.push(
      "> These captures were saved by different versions of Control Room. Sections still compare wherever both recorded them in the same shape.",
      "",
    );
  }
  for (const section of comparisonView(comparison, options)) {
    lines.push(`## ${sectionLabel(section.kind)}`, "");
    lines.push(`${statusLabel(section.baseStatus)} → ${statusLabel(section.targetStatus)}`, "");
    if (!section.comparable) {
      lines.push(section.note ?? "Not comparable.", "");
      continue;
    }
    if (section.note) lines.push(section.note, "");
    if (section.removalsIndeterminate) {
      lines.push(
        "> One side was read partially, so removals here are unverified rather than confirmed gone.",
        "",
      );
    }
    const changes = section.added.length + section.removed.length + section.changed.length;
    if (!changes) {
      lines.push(
        `No change across ${section.unchangedCount} compared entries${
          section.routineCount > 0 && !options.showRoutine
            ? `, ${section.routineCount} routine hidden`
            : ""
        }.`,
        "",
      );
      continue;
    }
    for (const entry of section.added) lines.push(`- Added \`${entry.label}\``);
    for (const entry of section.removed) lines.push(`- Removed \`${entry.label}\``);
    for (const entry of section.changed) {
      lines.push(`- Changed \`${entry.label}\``);
      // The export shows exactly the facts the view shows: hidden routine is
      // counted in the header, never silently included.
      const facts = options.showRoutine
        ? entry.changes
        : entry.changes.filter((fact) => !isRoutineChange(fact));
      for (const change of facts) {
        const suffix =
          change.classification === "routine"
            ? ` *(routine: ${change.reason ?? "this value moves on its own"})*`
            : "";
        lines.push(
          `  - ${change.name}: \`${change.baseValue ?? "not recorded"}\` → \`${change.targetValue ?? "not recorded"}\`${suffix}`,
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function comparisonToJson(comparison: BaselineComparison): string {
  return JSON.stringify(comparison, null, 2);
}

// A file name someone can find again a week later, and one no filesystem will
// reject.
export function exportFileName(comparison: BaselineComparison, extension: string): string {
  const safe = (value: string) =>
    value
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "capture";
  return `baseline-${safe(baselineTitle(comparison.base))}-to-${safe(
    comparisonTargetTitle(comparison),
  )}.${extension}`;
}
