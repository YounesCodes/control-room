import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type RefObject,
} from "react";
import {
  formatTickLabel,
  layoutReplayMarkers,
  markerGroupLabel,
  replayAxisTicks,
  type ReplayMarker,
} from "../../lib/boot-replay";

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
 * state is a pure function of the clock. Labels, tracks, the playhead, and
 * the tick axis all share one column split, so every readout measures the
 * same width.
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
  const axisStyle = { "--replay-progress": progress } as CSSProperties;
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [trackWidth, setTrackWidth] = useState(600);
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const measure = () => {
      const track = plot.querySelector(".boot-lane-track");
      if (track) setTrackWidth(track.getBoundingClientRect().width || 600);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(plot);
    return () => observer.disconnect();
  }, [lanes]);

  const seekFromPointer = (event: MouseEvent<HTMLDivElement>) => {
    const track = event.currentTarget.querySelector(".boot-lane-track");
    if (!track) return;
    const bounds = track.getBoundingClientRect();
    if (!bounds.width) return;
    const fraction = (event.clientX - bounds.left) / bounds.width;
    onSeek(Math.round(Math.min(1, Math.max(0, fraction)) * windowUs));
  };

  return (
    <div className="boot-timeline" ref={axisRef} style={axisStyle}>
      <div
        ref={plotRef}
        className="boot-timeline-plot"
        onClick={seekFromPointer}
        role="group"
        aria-label="Replay timeline plot"
      >
        {lanes.map((lane) => {
          const revealed = layoutReplayMarkers(
            lane.markers
              .filter((marker) => marker.offsetUs <= positionUs)
              .map((marker) => {
                const events = marker.events.filter((event) => (event.offsetUs ?? 0) <= positionUs);
                return {
                  ...marker,
                  events,
                  count: events.length,
                  spanUs: [marker.offsetUs, events.at(-1)?.offsetUs ?? marker.offsetUs] as [
                    number,
                    number,
                  ],
                };
              }),
            windowUs,
            trackWidth,
          );
          return (
            <div className="boot-lane" key={lane.id}>
              <span className="boot-lane-label">{lane.label}</span>
              <div className="boot-lane-track">
                {revealed.map((marker) => (
                  <button
                    type="button"
                    key={marker.key}
                    className={`boot-marker boot-marker-${marker.category}${marker.events.some((event) => event.id === selectedMarkerKey) ? " selected" : ""}`}
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
        <span className="boot-lane-label" />
        <div className="boot-lane-track boot-axis-track">
          {axisTicks.map((tick) => (
            <span key={tick} style={{ left: `${windowUs ? (tick / windowUs) * 100 : 0}%` }}>
              {formatTickLabel(tick)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// Distinct markers closer together than one glyph width would paint on top of
// each other; tight pairs take turns stepping down a lane row.
export function markerTitle(marker: ReplayMarker): string {
  if (marker.count > 1 && marker.similar === false) {
    return `${marker.count} events from ${formatTickLabel(marker.spanUs[0])} to ${formatTickLabel(marker.spanUs[1])}`;
  }
  const similar = marker.count > 1 ? ` (${markerGroupLabel(marker)})` : "";
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
