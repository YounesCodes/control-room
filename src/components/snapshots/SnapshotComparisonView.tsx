import { useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Copy, Download } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import {
  applyVolatileFilter,
  changeCount,
  comparisonSummary,
  comparisonTargetTitle,
  comparisonToJson,
  comparisonToMarkdown,
  exportFileName,
  formatCapturedAt,
  hasVolatileChanges,
  identityWarning,
  sectionLabel,
  snapshotTitle,
} from "../../lib/host-snapshots";
import type { SnapshotComparison, SnapshotSectionDiff } from "../../types";
import { StatusChip } from "./SnapshotSectionList";

export function SnapshotComparisonView({
  comparison,
  onError,
}: {
  comparison: SnapshotComparison;
  onError: (message: string) => void;
}) {
  const [hideVolatile, setHideVolatile] = useState(true);
  const [copied, setCopied] = useState(false);
  const volatilePresent = useMemo(() => hasVolatileChanges(comparison), [comparison]);
  const shown = useMemo(
    () => applyVolatileFilter(comparison, hideVolatile),
    [comparison, hideVolatile],
  );
  const warning = identityWarning(shown);

  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(comparisonToMarkdown(shown));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (caught) {
      onError(errorMessage(caught));
    }
  }

  async function exportFile(format: "md" | "json") {
    try {
      const path = await save({
        defaultPath: exportFileName(shown, format),
        filters: [{ name: format === "md" ? "Markdown" : "JSON", extensions: [format] }],
      });
      if (!path) return;
      await api.exportTextFile(
        path,
        format === "md" ? comparisonToMarkdown(shown) : comparisonToJson(shown),
      );
    } catch (caught) {
      onError(errorMessage(caught));
    }
  }

  return (
    <div className="snapshot-sections">
      <p className="snapshot-comparison-summary">
        {snapshotTitle(shown.base)} → {comparisonTargetTitle(shown)}: {comparisonSummary(shown)}
      </p>
      {shown.targetIsLive && (
        <p className="snapshot-comparison-note">
          Live state read {formatCapturedAt(shown.target.capturedAt)}. This read was not saved.
        </p>
      )}
      <div className="snapshot-comparison-tools">
        {volatilePresent && (
          <label className="snapshot-volatile-toggle">
            <input
              type="checkbox"
              checked={hideVolatile}
              onChange={(event) => setHideVolatile(event.target.checked)}
            />
            <span>Hide values that move on their own</span>
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
      {warning && <p className="inline-warning">{warning}</p>}
      {!shown.schemaCompatible && (
        <p className="inline-warning">
          These captures use different payload versions, so no section can be compared.
        </p>
      )}
      {shown.sections.map((section) => (
        <SectionDiffView key={section.kind} diff={section} />
      ))}
    </div>
  );
}

function SectionDiffView({ diff }: { diff: SnapshotSectionDiff }) {
  const changes = changeCount(diff);
  return (
    <section className="snapshot-section">
      <header>
        <h3>{sectionLabel(diff.kind)}</h3>
        <StatusChip status={diff.baseStatus} />
        <span aria-hidden="true">→</span>
        <StatusChip status={diff.targetStatus} />
      </header>
      {diff.note && <p className="inline-warning">{diff.note}</p>}
      {diff.comparable && (
        <p className="snapshot-section-count">
          {changes === 0
            ? `No change across ${diff.unchangedCount} compared entries`
            : `${changes} changed of ${changes + diff.unchangedCount} compared entries`}
        </p>
      )}
      {!!diff.added.length && (
        <ul className="snapshot-change-list">
          {diff.added.map((entry) => (
            <li key={`added-${entry.identity}`}>
              <span className="snapshot-change-mark snapshot-change-added">Added</span>
              <code>{entry.label}</code>
            </li>
          ))}
        </ul>
      )}
      {!!diff.removed.length && (
        <ul className="snapshot-change-list">
          {diff.removed.map((entry) => (
            <li key={`removed-${entry.identity}`}>
              <span className="snapshot-change-mark snapshot-change-removed">Removed</span>
              <code>{entry.label}</code>
            </li>
          ))}
        </ul>
      )}
      {!!diff.changed.length && (
        <ul className="snapshot-change-list">
          {diff.changed.map((entry) => (
            <li key={`changed-${entry.identity}`}>
              <span className="snapshot-change-mark">Changed</span>
              <code>{entry.label}</code>
              <ul className="snapshot-fact-list">
                {entry.changes.map((change) => (
                  <li key={change.name}>
                    <span>{change.name}</span>
                    <code>{change.baseValue ?? "not recorded"}</code>
                    <span aria-hidden="true">→</span>
                    <code>{change.targetValue ?? "not recorded"}</code>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
