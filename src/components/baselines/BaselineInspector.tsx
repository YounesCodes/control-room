import type { RecordedListenerSelection } from "../../lib/port-inspector";
import { useEffect, useRef, useState } from "react";
import { History, X } from "lucide-react";
import type {
  BaselineEntry,
  BaselineEntryChange,
  BaselineSectionKind,
  BaselineTrace,
} from "../../types";
import { api, errorMessage } from "../../lib/api";
import {
  formatCapturedAt,
  isRoutineChange,
  sectionLabel,
  statusLabel,
  recordedListenerSelection,
} from "../../lib/host-baselines";
import { WarningSign } from "../WarningSign";

/** What the inspector is looking at: one recorded resource, optionally placed
 * in its comparison context so the exact before and after speak for
 * themselves. */
export interface BaselineInspection {
  sectionKind: BaselineSectionKind;
  /** The recorded entry on the side that has it, when one exists. */
  entry: BaselineEntry | null;
  /** The comparison context, when the row came from the Changes view. */
  change: BaselineEntryChange | null;
  changeType: "added" | "removed" | "changed" | null;
  removalsIndeterminate: boolean;
  sectionNote: string | null;
  capturedAt?: string;
  additionsIndeterminate?: boolean;
}

interface BaselineInspectorProps {
  connectionId: string;
  inspection: BaselineInspection;
  onClose: () => void;
  onOpenSystemd?: (unit: string) => void;
  onOpenContainer?: (containerId: string) => void;
  onOpenListener?: (listener: RecordedListenerSelection) => void;
}

const CHANGE_TYPE_LABELS: Record<"added" | "removed" | "changed", string> = {
  added: "Appeared",
  removed: "Disappeared",
  changed: "Changed",
};

export function BaselineInspector({
  connectionId,
  inspection,
  onClose,
  onOpenSystemd,
  onOpenContainer,
  onOpenListener,
}: BaselineInspectorProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    headingRef.current?.focus();
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  const identity = inspection.entry?.identity ?? inspection.change?.identity ?? "";
  const label = inspection.entry?.label ?? inspection.change?.label ?? identity;
  const systemsUnit = unitFact(inspection, "systemdUnit");
  const containerId = unitFact(inspection, "containerId");
  const listener =
    inspection.sectionKind === "listeners" ? recordedListenerSelection(inspection.entry) : null;
  return (
    <div
      className="baseline-inspector"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      aria-label={`${label} details`}
    >
      <header className="baseline-inspector-header">
        <div>
          <h3 ref={headingRef} tabIndex={-1}>
            {label}
          </h3>
          <p>
            {sectionLabel(inspection.sectionKind)}
            {inspection.capturedAt ? ` · ${formatCapturedAt(inspection.capturedAt)}` : ""}
          </p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Close inspector"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      {inspection.changeType && (
        <p className={`baseline-inspector-type baseline-change-${inspection.changeType}`}>
          {inspection.changeType === "added" && inspection.additionsIndeterminate
            ? "First observed"
            : CHANGE_TYPE_LABELS[inspection.changeType]}{" "}
          in this comparison
        </p>
      )}
      {inspection.additionsIndeterminate && inspection.changeType === "added" && (
        <p className="inline-warning">
          <WarningSign />
          The earlier read was partial, so this resource may already have existed.
        </p>
      )}
      {inspection.changeType === "removed" && inspection.removalsIndeterminate && (
        <p className="inline-warning">
          <WarningSign />
          The read on one side was partial, so this disappearance is unverified rather than
          confirmed gone.
        </p>
      )}
      {inspection.sectionNote && (
        <p className="inline-warning">
          <WarningSign />
          {inspection.sectionNote}
        </p>
      )}
      {inspection.change?.changes.length ? (
        <section className="baseline-inspector-changes">
          <h4>Changed facts</h4>
          <ul>
            {inspection.change.changes.map((change) => (
              <li
                key={change.name}
                className={isRoutineChange(change) ? "baseline-inspector-fact-routine" : undefined}
              >
                <div className="baseline-inspector-fact-name">
                  {change.name}
                  {isRoutineChange(change) && (
                    <span className="baseline-routine-mark">Routine</span>
                  )}
                </div>
                <div className="baseline-inspector-values">
                  <code>{change.baseValue ?? "not recorded"}</code>
                  <span aria-hidden="true">→</span>
                  <code className="baseline-change-emphasis">
                    {change.targetValue ?? "not recorded"}
                  </code>
                </div>
                {change.reason && <p className="baseline-inspector-reason">{change.reason}</p>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {inspection.entry && (
        <details className="baseline-inspector-entry" open={!inspection.change}>
          <summary>
            {inspection.changeType === "removed" ? "Recorded in the earlier capture" : "Recorded"}
          </summary>
          <dl className="baseline-entry-facts">
            {inspection.entry.facts.map((fact) => (
              <div key={fact.name}>
                <dt>{fact.name}</dt>
                <dd className="technical">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <div className="baseline-inspector-links">
        {inspection.sectionKind === "listeners" && onOpenListener && (
          <button
            type="button"
            className="secondary-button"
            disabled={!listener}
            title={
              listener
                ? "Find the exact binding and owning unit in the current Ports snapshot."
                : "This capture does not identify a listener with a verified owning unit."
            }
            onClick={() => listener && onOpenListener(listener)}
          >
            Open in Ports
          </button>
        )}
        {inspection.sectionKind === "systemdUnits" && onOpenSystemd && identity && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => onOpenSystemd(identity)}
          >
            Open in Systemd
          </button>
        )}
        {inspection.sectionKind === "listeners" && onOpenSystemd && systemsUnit && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => onOpenSystemd(systemsUnit)}
          >
            Open owning unit in Systemd
          </button>
        )}
        {inspection.sectionKind === "containers" && onOpenContainer && (
          <button
            type="button"
            className="secondary-button"
            disabled={!containerId}
            title={
              containerId
                ? "Opens this exact container in the Docker view."
                : "This capture did not record the container ID, so Docker cannot be opened at the exact container."
            }
            onClick={() => containerId && onOpenContainer(containerId)}
          >
            Open in Docker
          </button>
        )}
      </div>
      {identity && (
        <EntryHistory
          key={`${connectionId}:${inspection.sectionKind}:${identity}`}
          connectionId={connectionId}
          kind={inspection.sectionKind}
          identity={identity}
        />
      )}
    </div>
  );
}

function unitFact(inspection: BaselineInspection, name: string): string | null {
  const value = (inspection.entry ?? inspection.change?.targetEntry)?.facts.find(
    (fact) => fact.name === name,
  )?.value;
  if (!value || value === "unavailable" || value === "none") return null;
  return value;
}

// History answers "when did this move," which a single pair never can. It reads
// only stored captures: no host is contacted.
function EntryHistory({
  connectionId,
  kind,
  identity,
}: {
  connectionId: string;
  kind: BaselineSectionKind;
  identity: string;
}) {
  const [trace, setTrace] = useState<BaselineTrace | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (trace || loading) return;
    setLoading(true);
    setError(null);
    try {
      setTrace(await api.traceHostBaselineEntry(connectionId, kind, identity));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="baseline-inspector-history">
      <button
        className="secondary-button"
        type="button"
        aria-expanded={open}
        onClick={() => void toggle()}
      >
        <History size={14} /> {open ? "Hide history" : "Read across captures"}
      </button>
      {loading && <p className="baseline-section-count">Reading saved captures…</p>}
      {error && <p className="inline-error">{error}</p>}
      {open && trace && <TraceTable trace={trace} />}
    </div>
  );
}

export function TraceTable({ trace }: { trace: BaselineTrace }) {
  const names = [...new Set(trace.points.flatMap((point) => point.facts.map((fact) => fact.name)))];
  return (
    <div
      className="baseline-trace"
      tabIndex={0}
      role="region"
      aria-label="Recorded resource history"
    >
      <table>
        <thead>
          <tr>
            <th scope="col">Capture</th>
            {names.map((name) => (
              <th scope="col" key={name}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {trace.points.map((point) => (
            <tr key={point.baselineId}>
              <th scope="row">
                {point.label && (
                  <span>
                    {point.label}
                    <br />
                  </span>
                )}
                <time dateTime={point.capturedAt}>{formatCapturedAt(point.capturedAt)}</time>
              </th>
              {point.present ? (
                names.map((name) => (
                  <td className="technical" key={name}>
                    {point.facts.find((fact) => fact.name === name)?.value ?? "not recorded"}
                  </td>
                ))
              ) : (
                <td className="baseline-trace-absent" colSpan={names.length || 1}>
                  {point.sectionStatus === "collected"
                    ? "Not present in this capture"
                    : point.sectionStatus === "partial"
                      ? "Not observed, partial read"
                      : statusLabel(point.sectionStatus)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
