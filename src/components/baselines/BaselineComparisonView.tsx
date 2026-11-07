import { useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Copy, Download } from "lucide-react";
import type { BaselineComparison, BaselineEntry, BaselineEntryChange } from "../../types";
import {
  baselineTitle,
  comparisonTargetTitle,
  comparisonSummary,
  comparisonToMarkdown,
  comparisonToJson,
  comparisonView,
  exportFileName,
  formatCapturedAt,
  identityWarning,
  sectionLabel,
  type ComparisonSectionView,
  type ComparisonViewOptions,
} from "../../lib/host-baselines";
import { api, errorMessage } from "../../lib/api";
import { StatusChip } from "./BaselineSectionList";
import { WarningSign } from "../WarningSign";

interface BaselineComparisonViewProps {
  comparison: BaselineComparison;
  showRoutine: boolean;
  search: string;
  selectedIdentity: string | null;
  onShowRoutineChange: (show: boolean) => void;
  onInspectEntry: (
    section: ComparisonSectionView,
    entry: BaselineEntry,
    changeType: "added" | "removed",
  ) => void;
  onInspectChange: (section: ComparisonSectionView, change: BaselineEntryChange) => void;
  onError: (message: string) => void;
  onClearFilters?: () => void;
  /** Sidebars render tools only once; the view lives in the busy half. */
  compact?: boolean;
}

// A comparison reads like a review: rows grouped by what they mean, the quiet
// categories folded away, and every routine difference counted where it can be
// asked for instead of buried or deleted.
export function BaselineComparisonView({
  comparison,
  showRoutine,
  search,
  selectedIdentity,
  onShowRoutineChange,
  onInspectEntry,
  onInspectChange,
  onError,
  onClearFilters,
  compact = false,
}: BaselineComparisonViewProps) {
  const [copied, setCopied] = useState(false);
  const [changeType, setChangeType] =
    useState<NonNullable<ComparisonViewOptions["changeType"]>>("all");
  const [sectionKind, setSectionKind] =
    useState<NonNullable<ComparisonViewOptions["sectionKind"]>>("all");
  const options: ComparisonViewOptions = {
    showRoutine,
    search,
    ...(changeType !== "all" ? { changeType } : {}),
    ...(sectionKind !== "all" ? { sectionKind } : {}),
  };
  const sections = useMemo(
    () => comparisonView(comparison, options),
    [comparison, showRoutine, search, changeType, sectionKind],
  );
  const routineTotal = comparison.sections
    .filter((section) => section.comparable)
    .reduce((total, section) => total + section.routineCount, 0);
  const warning = identityWarning(comparison);
  const markdown = () => comparisonToMarkdown(comparison, options);

  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(markdown());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (caught) {
      onError(errorMessage(caught));
    }
  }

  async function exportFile(format: "md" | "json") {
    try {
      const path = await save({
        defaultPath: exportFileName(comparison, format),
        filters: [{ name: format === "md" ? "Markdown" : "JSON", extensions: [format] }],
      });
      if (!path) return;
      await api.exportTextFile(
        path,
        format === "md" ? markdown() : comparisonToJson(comparison, options),
      );
    } catch (caught) {
      onError(errorMessage(caught));
    }
  }

  // Sections that actually moved sit on top; everything quieter is folded
  // behind a summary it can be asked to open on demand.
  const ordered = [...sections].sort((left, right) => {
    const leftChanges = left.added.length + left.removed.length + left.changed.length;
    const rightChanges = right.added.length + right.removed.length + right.changed.length;
    return (
      Number(right.comparable && rightChanges > 0) - Number(left.comparable && leftChanges > 0)
    );
  });
  const filteredOut = sections.some((section) => section.filteredCount > 0);
  const noMatches =
    filteredOut &&
    sections.every(
      (section) => !section.added.length && !section.removed.length && !section.changed.length,
    );
  const viewKey = `${comparison.base.id}:${comparison.target.id}:${comparison.targetIsLive}`;

  return (
    <div className="baseline-sections" key={viewKey}>
      <div className="baseline-comparison-direction">
        <span>{baselineTitle(comparison.base)}</span>
        <span aria-label="compared to">→</span>
        <span>{comparisonTargetTitle(comparison)}</span>
      </div>
      <p className="baseline-comparison-summary">{comparisonSummary(comparison, options)}</p>
      {comparison.targetIsLive && (
        <p className="baseline-comparison-note">
          Live state read {formatCapturedAt(comparison.target.capturedAt)}. This read was not saved.
        </p>
      )}
      {!comparison.schemaCompatible && (
        <p className="inline-warning">
          <WarningSign />
          These captures were saved by different versions of Control Room. Sections compare wherever
          both recorded them in the same shape.
        </p>
      )}
      {warning && (
        <p className="inline-warning">
          <WarningSign />
          {warning}
        </p>
      )}
      <details className="baseline-change-filters">
        <summary>
          Filter changes{changeType !== "all" || sectionKind !== "all" ? " · active" : ""}
        </summary>
        <label>
          Change type
          <select
            aria-label="Change type"
            value={changeType}
            onChange={(event) => setChangeType(event.target.value as typeof changeType)}
          >
            <option value="all">All changes</option>
            <option value="added">Added</option>
            <option value="removed">Removed</option>
            <option value="changed">Changed</option>
          </select>
        </label>
        <label>
          Section
          <select
            aria-label="Change section"
            value={sectionKind}
            onChange={(event) => setSectionKind(event.target.value as typeof sectionKind)}
          >
            <option value="all">All sections</option>
            {comparison.sections.map((section) => (
              <option key={section.kind} value={section.kind}>
                {sectionLabel(section.kind)}
              </option>
            ))}
          </select>
        </label>
      </details>
      <div className="baseline-comparison-tools">
        {routineTotal > 0 && (
          <label className="baseline-volatile-toggle">
            <input
              type="checkbox"
              checked={showRoutine}
              onChange={(event) => onShowRoutineChange(event.target.checked)}
            />
            <span>Show routine changes</span>
          </label>
        )}
        <button className="secondary-button" type="button" onClick={() => void copyMarkdown()}>
          <Copy size={14} /> {copied ? "Copied" : "Copy"}
        </button>
        <button className="secondary-button" type="button" onClick={() => void exportFile("md")}>
          <Download size={14} /> Markdown
        </button>
        <button className="secondary-button" type="button" onClick={() => void exportFile("json")}>
          <Download size={14} /> JSON
        </button>
      </div>
      {selectedIdentity &&
        !sections.some((section) =>
          [...section.added, ...section.removed, ...section.changed].some(
            (entry) => entry.identity === selectedIdentity,
          ),
        ) && (
          <p className="inline-warning">
            <WarningSign />
            Selection hidden by filters.{" "}
            <button
              className="link-button"
              type="button"
              onClick={() => {
                setChangeType("all");
                setSectionKind("all");
                onClearFilters?.();
              }}
            >
              Clear filters
            </button>
          </p>
        )}
      {noMatches && <p role="status">No differences match the current filters.</p>}
      {ordered.map((section) => (
        <SectionDiffView
          key={section.kind}
          diff={section}
          showRoutine={showRoutine}
          selectedIdentity={selectedIdentity}
          onInspectEntry={onInspectEntry}
          onInspectChange={onInspectChange}
          onShowRoutineChange={onShowRoutineChange}
          compact={compact}
        />
      ))}
    </div>
  );
}

function SectionDiffView({
  diff,
  showRoutine,
  selectedIdentity,
  onInspectEntry,
  onInspectChange,
  onShowRoutineChange,
  compact,
}: {
  diff: ComparisonSectionView;
  showRoutine: boolean;
  selectedIdentity: string | null;
  onInspectEntry: (
    section: ComparisonSectionView,
    entry: BaselineEntry,
    changeType: "added" | "removed",
  ) => void;
  onInspectChange: (section: ComparisonSectionView, change: BaselineEntryChange) => void;
  onShowRoutineChange: (show: boolean) => void;
  compact: boolean;
}) {
  const [visibleLimit, setVisibleLimit] = useState(150);
  const changes = diff.added.length + diff.removed.length + diff.changed.length;
  const visibleAdded = diff.added.slice(0, visibleLimit);
  const visibleRemoved = diff.removed.slice(0, Math.max(0, visibleLimit - visibleAdded.length));
  const visibleChanged = diff.changed.slice(
    0,
    Math.max(0, visibleLimit - visibleAdded.length - visibleRemoved.length),
  );
  if (!diff.comparable) {
    return (
      <section className="baseline-section baseline-section-incomparable">
        <header>
          <h3>{sectionLabel(diff.kind)}</h3>
          <StatusChip status={diff.baseStatus} />
          <span aria-hidden="true">→</span>
          <StatusChip status={diff.targetStatus} />
        </header>
        <p className="inline-warning">
          <WarningSign />
          {diff.note}
        </p>
      </section>
    );
  }
  if (changes === 0 && diff.filteredCount > 0)
    return (
      <section className="baseline-section">
        <h3>{sectionLabel(diff.kind)}</h3>
        <p className="baseline-section-count">{diff.filteredCount} differences filtered out</p>
        {diff.note && (
          <p className="inline-warning">
            <WarningSign />
            {diff.note}
          </p>
        )}
      </section>
    );
  if (changes === 0) {
    const routineHidden = !showRoutine && diff.routineCount > 0;
    return (
      <details className="baseline-section baseline-section-unchanged">
        <summary>
          <span className="baseline-unchanged-title">{sectionLabel(diff.kind)}</span>
          <StatusChip status={diff.baseStatus} />
          <span aria-hidden="true">→</span>
          <StatusChip status={diff.targetStatus} />
          <span className="baseline-unchanged-count">
            {routineHidden
              ? `${diff.routineCount} routine changes hidden`
              : `${diff.unchangedCount} compared, no changes`}
          </span>
        </summary>
        {diff.note && (
          <p className="inline-warning">
            <WarningSign />
            {diff.note}
          </p>
        )}
        <p className="baseline-section-count">
          {routineHidden ? (
            <>
              Only routine churn moved here.{" "}
              <button
                className="link-button"
                type="button"
                onClick={() => onShowRoutineChange(true)}
              >
                Show routine changes
              </button>{" "}
              to read it.
            </>
          ) : (
            "No stored fact changed in this section across these captures."
          )}
        </p>
      </details>
    );
  }
  return (
    <section className="baseline-section">
      <header>
        <h3>{sectionLabel(diff.kind)}</h3>
        <StatusChip status={diff.baseStatus} />
        <span aria-hidden="true">→</span>
        <StatusChip status={diff.targetStatus} />
        <span className="baseline-section-count">
          {`${changes} ${changes === 1 ? "difference" : "differences"} of ${changes + diff.unchangedCount} compared`}
        </span>
      </header>
      {diff.note && (
        <p className="inline-warning">
          <WarningSign />
          {diff.note}
        </p>
      )}
      {diff.removalsIndeterminate && !!diff.removed.length && (
        <p className="inline-warning">
          <WarningSign />
          One side was read partially, so removals here are unverified, not confirmed gone.
        </p>
      )}
      {!!diff.added.length && (
        <ul className="baseline-change-list">
          {visibleAdded.map((entry) => (
            <li key={`added-${entry.identity}`}>
              <ChangeRowButton
                mark={diff.baseStatus === "partial" ? "First observed" : "Added"}
                classNameMark="baseline-change-added"
                selected={selectedIdentity === entry.identity}
                onClick={() => onInspectEntry(diff, entry, "added")}
              >
                <code>{entry.label}</code>
              </ChangeRowButton>
            </li>
          ))}
        </ul>
      )}
      {!!diff.removed.length && (
        <ul className="baseline-change-list">
          {visibleRemoved.map((entry) => (
            <li key={`removed-${entry.identity}`}>
              <ChangeRowButton
                mark={diff.removalsIndeterminate ? "Unverified" : "Removed"}
                classNameMark="baseline-change-removed"
                selected={selectedIdentity === entry.identity}
                onClick={() => onInspectEntry(diff, entry, "removed")}
              >
                <code>{entry.label}</code>
              </ChangeRowButton>
            </li>
          ))}
        </ul>
      )}
      {changes > visibleLimit && (
        <button
          type="button"
          className="secondary-button"
          onClick={() => setVisibleLimit((limit) => limit + 150)}
        >
          Show next {Math.min(150, changes - visibleLimit)} differences
        </button>
      )}
      {!!diff.changed.length && (
        <ul className="baseline-change-list">
          {visibleChanged.map((entry) => {
            const meaningful = entry.changes.filter(
              (change) => change.classification === "meaningful",
            );
            const lead = meaningful[0] ?? entry.changes[0];
            const routineOnly = meaningful.length === 0;
            return (
              <li key={`changed-${entry.identity}`}>
                <ChangeRowButton
                  mark={routineOnly ? "Routine" : "Changed"}
                  classNameMark={routineOnly ? "baseline-change-routine" : undefined}
                  title={lead?.reason ?? undefined}
                  selected={selectedIdentity === entry.identity}
                  onClick={() => onInspectChange(diff, entry)}
                >
                  <code>{entry.label}</code>
                  {lead && (
                    <small className="baseline-change-lead">
                      {lead.name}: {lead.baseValue ?? "not recorded"} →{" "}
                      {lead.targetValue ?? "not recorded"}
                    </small>
                  )}
                </ChangeRowButton>
              </li>
            );
          })}
        </ul>
      )}
      {!compact && (
        <p className="baseline-section-count">
          {`No change across the remaining ${diff.unchangedCount} compared entries.`}
        </p>
      )}
    </section>
  );
}

function ChangeRowButton({
  mark,
  classNameMark,
  title,
  selected,
  onClick,
  children,
}: {
  mark: string;
  classNameMark?: string;
  title?: string;
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={
        selected ? "baseline-change-row baseline-change-row-selected" : "baseline-change-row"
      }
      type="button"
      title={title}
      onClick={onClick}
    >
      <span
        className={classNameMark ? `baseline-change-mark ${classNameMark}` : "baseline-change-mark"}
      >
        {mark}
      </span>
      {children}
    </button>
  );
}
