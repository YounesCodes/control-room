import type { CSSProperties, MouseEvent, RefObject } from "react";
import { formatTickLabel, replayAxisTicks, type ReplayMarker } from "../../lib/boot-replay";

export interface ReplayLane {
  id: string;
  label: string;
  markers: ReplayMarker[];
}

/**
 * The hero timeline: one shared time axis, one low row per evidence-backed
 * lane, and a playhead driven by a CSS variable so the pane can move it every
 * frame without re-rendering. Markers mount only once the playhead has
 * crossed their recorded offsets and unmount on a backward seek, so revealed
 * state is a pure function of the clock.
 */
export function BootTimeline({
  windowUs,
  positionUs,
  lanes,
  selectedMarkerKey,
  onSeek,
  onSelectMarker,
  axisRef,
}: {
  windowUs: number;
  positionUs: number;
  lanes: ReplayLane[];
  selectedMarkerKey: string | null;
  onSeek: (positionUs: number) => void;
  onSelectMarker: (marker: ReplayMarker) => void;
  axisRef: RefObject<HTMLDivElement | null>;
}) {
  const progress = windowUs > 0 ? Math.min(1, Math.max(0, positionUs / windowUs)) : 0;
  const axisTicks = replayAxisTicks(windowUs);
  const axisStyle = { "--replay-progress": `${progress * 100}%` } as CSSProperties;

  const seekFromPointer = (event: MouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    const fraction = (event.clientX - bounds.left) / bounds.width;
    onSeek(Math.round(Math.min(1, Math.max(0, fraction)) * windowUs));
  };

  return (
    <div className="boot-timeline" ref={axisRef} style={axisStyle}>
      <div
        className="boot-timeline-plot"
        onClick={seekFromPointer}
        role="group"
        aria-label="Replay timeline plot"
      >
        {lanes.map((lane) => {
          const revealed = lane.markers.filter((marker) => marker.offsetUs <= positionUs);
          return (
            <div className="boot-lane" key={lane.id}>
              <span className="boot-lane-label">{lane.label}</span>
              <div className="boot-lane-track">
                {revealed.map((marker) => (
                  <button
                    type="button"
                    key={marker.key}
                    className={`boot-marker boot-marker-${marker.category}${
                      marker.key === selectedMarkerKey ? " selected" : ""
                    }`}
                    style={{ left: `${(marker.offsetUs / windowUs) * 100}%` }}
                    title={markerTitle(marker)}
                    aria-label={markerTitle(marker)}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectMarker(marker);
                    }}
                  >
                    {marker.count > 1 && <span className="boot-marker-count">{marker.count}</span>}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        <div className="boot-playhead" aria-hidden="true" />
      </div>
      <div className="boot-timeline-axis" aria-hidden="true">
        {axisTicks.map((tick) => (
          <span key={tick} style={{ left: `${windowUs ? (tick / windowUs) * 100 : 0}%` }}>
            {formatTickLabel(tick)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function markerTitle(marker: ReplayMarker): string {
  const similar = marker.count > 1 ? ` (${marker.count} similar events)` : "";
  return `${categoryLabel(marker.category)} at ${formatTickLabel(marker.offsetUs)}: ${marker.label}${similar}`;
}

export function categoryLabel(category: ReplayMarker["category"]): string {
  switch (category) {
    case "error":
      return "Failure";
    case "warning":
      return "Warning";
    case "milestone":
      return "Milestone";
    case "unit":
      return "Unit event";
    default:
      return "Journal record";
  }
}
