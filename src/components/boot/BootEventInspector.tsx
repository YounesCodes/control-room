import { X } from "lucide-react";
import {
  formatTPlus,
  replayEventSummary,
  replayPriorityLabel,
  type ReplayMarker,
} from "../../lib/boot-replay";
import { categoryLabel } from "./BootTimeline";

function realtimeLabel(realtimeUs: number | null): string {
  if (realtimeUs === null) return "Not recorded";
  const date = new Date(realtimeUs / 1000);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString();
}

/**
 * The contextual drawer for one selected marker. It shows only what the
 * journal recorded: timestamps, provenance, the raw message, and — for a
 * clustered marker — every event the cluster stands for. Nothing here
 * claims a root cause or a host state that was not logged.
 */
export function BootEventInspector({
  marker,
  windowUs,
  onClose,
  onOpenUnit,
  onViewUnitJournal,
}: {
  marker: ReplayMarker;
  windowUs: number;
  onClose: () => void;
  onOpenUnit?: (unit: string) => void;
  onViewUnitJournal?: (unit: string) => void;
}) {
  const lead = marker.events[0];
  const unit = marker.events.find((event) => event.unit)?.unit ?? null;
  return (
    <section className="boot-event-inspector" aria-label="Replay event details">
      <header>
        <h3>
          {categoryLabel(marker.category)} <span>· {formatTPlus(marker.offsetUs)}</span>
        </h3>
        <button
          type="button"
          className="secondary-button"
          onClick={onClose}
          aria-label="Close event details"
        >
          <X size={15} />
        </button>
      </header>
      <p className="boot-event-summary">{replayEventSummary(lead, windowUs)}</p>
      <dl className="boot-event-fields">
        <div>
          <dt>Replay offset</dt>
          <dd>{formatTPlus(marker.offsetUs)}</dd>
        </div>
        <div>
          <dt>Wall-clock time</dt>
          <dd>{realtimeLabel(lead.realtimeUs)}</dd>
        </div>
        <div>
          <dt>Journal priority</dt>
          <dd>
            {lead.priority !== null
              ? `${replayPriorityLabel(lead.priority) ?? "unknown"} (${lead.priority})`
              : "Not recorded"}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{lead.source ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>Unit</dt>
          <dd>{unit ?? "None recorded"}</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>Retained journal record — observed, not inferred</dd>
        </div>
      </dl>
      <p className="boot-event-message">{lead.message}</p>
      {marker.count > 1 && (
        <div className="boot-event-cluster">
          <p>
            {marker.count} similar events, from {formatTPlus(marker.spanUs[0])} to{" "}
            {formatTPlus(marker.spanUs[1])}:
          </p>
          <ul>
            {marker.events.map((event) => (
              <li key={event.id}>
                <span>{formatTPlus(event.offsetUs ?? 0)}</span>
                <span>{event.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {unit && (onOpenUnit || onViewUnitJournal) && (
        <footer>
          {onOpenUnit && (
            <button type="button" className="secondary-button" onClick={() => onOpenUnit(unit)}>
              Open unit in Systemd
            </button>
          )}
          {onViewUnitJournal && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => onViewUnitJournal(unit)}
            >
              View unit journal
            </button>
          )}
        </footer>
      )}
    </section>
  );
}
