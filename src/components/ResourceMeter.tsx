import { sparklineAreaPath, sparklinePath } from "../lib/host-resources";

// Drawn in a fixed coordinate space and stretched to the tile. The stroke is
// kept unscaled so a wide tile does not thin the line out.
const VIEW_WIDTH = 240;
const VIEW_HEIGHT = 40;

export function ResourceMeter({
  label,
  percent,
  detail,
  history,
  unavailable,
}: {
  label: string;
  /** Current reading, 0 to 100. Null when the host did not report one. */
  percent: number | null;
  detail: string;
  /** Oldest first. Fewer than two points draws no line. */
  history: number[];
  /** Why there is no reading, when there is none. */
  unavailable?: string;
}) {
  const line = sparklinePath(history, VIEW_WIDTH, VIEW_HEIGHT);
  const area = sparklineAreaPath(history, VIEW_WIDTH, VIEW_HEIGHT);
  const reading = percent === null ? null : `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;

  return (
    <div className="resource-meter">
      <div className="resource-meter-head">
        <span className="overview-stat-label">{label}</span>
        <strong className="overview-stat-value">{reading ?? "Unavailable"}</strong>
      </div>
      {/* The chart is decoration over numbers already stated in text, so it is
          hidden from assistive tech rather than described twice. */}
      <svg
        className="resource-sparkline"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {area && <path className="resource-sparkline-area" d={area} />}
        {line && (
          <path className="resource-sparkline-line" d={line} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <span className="overview-stat-hint">
        {reading === null ? (unavailable ?? detail) : detail}
      </span>
    </div>
  );
}
