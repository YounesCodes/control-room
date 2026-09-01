import { Boxes, Eraser, FileClock, PlugZap, Server, SquareTerminal, Unplug } from "lucide-react";
import { EmptyState } from "../components/PanelState";
import { formatTimelineTime, isDisconnectBoundary } from "../lib/session-timeline";
import type { TimelineEvent, TimelineEventKind, TimelineTarget } from "../types";

interface TimelinePaneProps {
  timeline: TimelineEvent[];
  historyEnabled: boolean;
  onClear: () => void;
  onOpenTarget: (target: TimelineTarget) => void;
}

const ICONS: Record<TimelineEventKind, typeof PlugZap> = {
  connected: PlugZap,
  reconnected: PlugZap,
  disconnected: Unplug,
  connectionFailed: Unplug,
  command: SquareTerminal,
  openedObject: Server,
  logStreamStarted: FileClock,
  logStreamStopped: FileClock,
};

export function TimelinePane({
  timeline,
  historyEnabled,
  onClear,
  onOpenTarget,
}: TimelinePaneProps) {
  return (
    <section className="feature-page timeline-page">
      <header className="page-heading">
        <div>
          <h2>Timeline</h2>
          <p>{timeline.length} events in this Workspace</p>
          <small className="unit-scope-note">
            Held in memory for this Workspace only. Closing Control Room clears it.
          </small>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onClear}
          aria-label="Clear timeline"
          disabled={!timeline.length}
        >
          <Eraser size={16} />
        </button>
      </header>
      {!historyEnabled && (
        <p className="inline-warning">
          Enhanced History is off for this connection, so commands are not recorded. Connection,
          object, and Log Stream events still appear.
        </p>
      )}
      {!timeline.length ? (
        <EmptyState title="Nothing recorded yet">
          Connecting, opening a unit or container, and starting a Log Stream all appear here.
        </EmptyState>
      ) : (
        <ol className="timeline-list">
          {timeline.map((event) => {
            const Icon = ICONS[event.kind] ?? SquareTerminal;
            const target = event.target;
            const navigable = target?.type === "systemdUnit" || target?.type === "dockerContainer";
            return (
              <li
                key={event.id}
                className={
                  isDisconnectBoundary(event) ? "timeline-row timeline-boundary" : "timeline-row"
                }
              >
                <time dateTime={event.at}>{formatTimelineTime(event.at)}</time>
                <span className={`timeline-mark timeline-mark-${event.kind}`} aria-hidden="true">
                  <Icon size={13} strokeWidth={1.8} />
                </span>
                <span className="timeline-body">
                  <span className={event.kind === "command" ? "technical" : undefined}>
                    {event.label}
                  </span>
                  {event.detail && <small>{event.detail}</small>}
                  {event.repeatCount > 1 && (
                    <small className="timeline-repeat">repeated {event.repeatCount} times</small>
                  )}
                </span>
                {navigable && target && (
                  <button
                    className="timeline-open"
                    type="button"
                    onClick={() => onOpenTarget(target)}
                  >
                    {target.type === "systemdUnit" ? <Server size={13} /> : <Boxes size={13} />}
                    Open
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
