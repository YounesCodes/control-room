import { useState } from "react";
import { ChevronDown, ChevronRight, History } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { formatCapturedAt, sectionLabel, statusHint, statusLabel } from "../../lib/host-baselines";
import type {
  HostBaseline,
  BaselineEntry,
  BaselineSection,
  BaselineSectionKind,
  BaselineSectionStatus,
  BaselineTrace,
} from "../../types";

export function StatusChip({ status }: { status: BaselineSectionStatus }) {
  return (
    <span className={`baseline-status baseline-status-${status}`} title={statusHint(status)}>
      {statusLabel(status)}
    </span>
  );
}

export function BaselineSectionList({
  connectionId,
  baseline,
}: {
  connectionId: string;
  baseline: HostBaseline;
}) {
  return (
    <div className="baseline-sections">
      {baseline.sections.map((section) => (
        <SectionView key={section.kind} connectionId={connectionId} section={section} />
      ))}
    </div>
  );
}

// A capture is worth opening on its own, not only as one side of a diff, so
// every section that read something can be expanded to the entries it recorded.
function SectionView({
  connectionId,
  section,
}: {
  connectionId: string;
  section: BaselineSection;
}) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState("");
  const expandable = section.entries.length > 0;
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? section.entries.filter(
        (entry) =>
          entry.label.toLowerCase().includes(needle) ||
          entry.facts.some((fact) => fact.value.toLowerCase().includes(needle)),
      )
    : section.entries;

  return (
    <section className="baseline-section">
      <header>
        {expandable ? (
          <button
            className="baseline-section-toggle"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <h3>{sectionLabel(section.kind)}</h3>
          </button>
        ) : (
          <h3>{sectionLabel(section.kind)}</h3>
        )}
        <StatusChip status={section.status} />
        {section.kind !== "host" && (
          <span className="baseline-section-count">{section.entries.length} recorded</span>
        )}
      </header>
      {section.message && <p className="inline-warning">{section.message}</p>}
      {expanded && (
        <>
          {section.entries.length > 8 && (
            <input
              className="baseline-entry-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={`Filter ${section.entries.length} entries`}
              aria-label={`Filter ${sectionLabel(section.kind)}`}
            />
          )}
          <ul className="baseline-entry-list">
            {visible.map((entry) => (
              <EntryRow
                key={entry.identity}
                connectionId={connectionId}
                kind={section.kind}
                entry={entry}
              />
            ))}
          </ul>
          {!visible.length && <p className="baseline-section-count">No entry matches that text</p>}
        </>
      )}
    </section>
  );
}

function EntryRow({
  connectionId,
  kind,
  entry,
}: {
  connectionId: string;
  kind: BaselineSectionKind;
  entry: BaselineEntry;
}) {
  const [trace, setTrace] = useState<BaselineTrace | null>(null);
  const [tracing, setTracing] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);

  async function toggleTrace() {
    if (trace) {
      setTrace(null);
      return;
    }
    setTracing(true);
    setTraceError(null);
    try {
      setTrace(await api.traceHostBaselineEntry(connectionId, kind, entry.identity));
    } catch (caught) {
      setTraceError(errorMessage(caught));
    } finally {
      setTracing(false);
    }
  }

  return (
    <li>
      <div className="baseline-entry-head">
        <code>{entry.label}</code>
        <button
          className="icon-button"
          type="button"
          aria-label={`History of ${entry.label}`}
          aria-pressed={Boolean(trace)}
          onClick={() => void toggleTrace()}
        >
          <History size={14} />
        </button>
      </div>
      <dl className="baseline-entry-facts">
        {entry.facts.map((fact) => (
          <div key={fact.name}>
            <dt>{fact.name}</dt>
            <dd className="technical">{fact.value}</dd>
          </div>
        ))}
      </dl>
      {tracing && <p className="baseline-section-count">Reading saved captures…</p>}
      {traceError && <p className="inline-error">{traceError}</p>}
      {trace && <TraceTable trace={trace} />}
    </li>
  );
}

// Two captures answer what changed. Reading one entry down the whole history
// answers when it changed, which is usually the actual question.
function TraceTable({ trace }: { trace: BaselineTrace }) {
  const names = [...new Set(trace.points.flatMap((point) => point.facts.map((fact) => fact.name)))];
  return (
    <div className="baseline-trace">
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
              <th scope="row">{point.label ?? formatCapturedAt(point.capturedAt)}</th>
              {point.present ? (
                names.map((name) => (
                  <td className="technical" key={name}>
                    {point.facts.find((fact) => fact.name === name)?.value ?? "not recorded"}
                  </td>
                ))
              ) : (
                <td className="baseline-trace-absent" colSpan={names.length || 1}>
                  {point.sectionStatus === "collected" || point.sectionStatus === "partial"
                    ? "Not present in this capture"
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
