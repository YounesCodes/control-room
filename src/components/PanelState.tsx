import type { CSSProperties, ReactNode } from "react";
import { AlertCircle, Inbox } from "lucide-react";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="panel-state" aria-live="polite">
      <span className="spinner" />
      <p>{label}</p>
    </div>
  );
}

/*
 * Skeletons sketch the content that is loading with the same layout classes
 * that content uses, so every row, field, and card lands exactly where the
 * placeholder stood. `Skeleton` is the one status for a loading area; the
 * shapes inside it are hidden from assistive technology.
 */

/** Varied but stable widths so placeholder text reads as text, not a grid. */
const WIDTHS = [72, 54, 84, 62, 46, 78, 58, 68];

/** A stable length from the shared sequence, scaled to `max`. */
const span = (index: number, max: number) =>
  Math.round((WIDTHS[index % WIDTHS.length] * max) / 100);

/** A stable CSS width from the shared sequence, scaled to `max`. */
export const boneWidth = (index: number, max = 100, unit = "%") => `${span(index, max)}${unit}`;

type BoneShape =
  "text" | "title" | "caption" | "control" | "button" | "icon" | "mark" | "dot" | "block";

/** One placeholder shape: a line of text, a control, an icon, or a status dot. */
export function Bone({
  shape = "text",
  width,
  className,
}: {
  shape?: BoneShape;
  width?: string;
  className?: string;
}) {
  return (
    <span
      className={className ? `skeleton-bone ${className}` : "skeleton-bone"}
      data-shape={shape}
      style={width ? ({ "--bone-width": width } as CSSProperties) : undefined}
    />
  );
}

/** Marks one row of a skeleton so rows pulse in sequence, top to bottom. */
export const wave = (index: number) => ({ "--skeleton-row": index }) as CSSProperties;

/**
 * The status for one loading area. `label` names what is being read for
 * assistive technology; `children` sketch the content in its own layout.
 */
export function Skeleton({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className ? `skeleton ${className}` : "skeleton"} role="status">
      <span className="sr-only">{label}</span>
      <div className="skeleton-shape" aria-hidden="true">
        {children}
      </div>
    </div>
  );
}

/** Dense list rows: an optional status mark, a title over a detail, and a state. */
export function SkeletonRows({
  count = 8,
  lead = false,
  state = "text",
}: {
  count?: number;
  lead?: boolean;
  state?: "text" | "status" | "none";
}) {
  return Array.from({ length: count }, (_, index) => (
    <div className="dense-row skeleton-row" key={index} style={wave(index)}>
      {lead && <Bone shape="dot" />}
      <span className="row-main">
        <Bone width={boneWidth(index, 260, "px")} />
        <Bone shape="caption" width={boneWidth(index + 3, 170, "px")} />
      </span>
      {state !== "none" && (
        <span className="row-state">
          {state === "status" && <Bone shape="dot" />}
          <Bone shape="caption" width={boneWidth(index + 5, 64, "px")} />
        </span>
      )}
    </div>
  ));
}

/** Label and value pairs in the shared detail list layout. */
export function SkeletonFields({
  count = 4,
  className = "detail-list",
  offset = 0,
}: {
  count?: number;
  className?: string;
  offset?: number;
}) {
  return (
    <div className={`${className} skeleton-fields`}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} style={wave(index + offset)}>
          <Bone shape="caption" width={boneWidth(index + 2, 92, "px")} />
          <Bone width={boneWidth(index, 220, "px")} />
        </div>
      ))}
    </div>
  );
}

/** A detail panel's heading over its fields. It belongs to the page's loading
 *  status, so it adds none of its own. */
export function SkeletonDetail({ fields = 4 }: { fields?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      <header className="skeleton-heading skeleton-row">
        <Bone shape="title" width="180px" />
        <Bone shape="caption" width="240px" />
      </header>
      <SkeletonFields count={fields} offset={1} />
    </div>
  );
}

/** Collapsed inspector sections, each a heading on a divider. */
export function SkeletonSections({ count, offset = 0 }: { count: number; offset?: number }) {
  return Array.from({ length: count }, (_, index) => (
    <div className="port-disclosure skeleton-row" key={index} style={wave(index + offset)}>
      <Bone shape="title" width={boneWidth(index + 4, 120, "px")} />
    </div>
  ));
}

/** Lines of text or code, such as a unit file, or with `lead`, timestamped log lines. */
export function SkeletonLines({
  count = 6,
  offset = 0,
  lead = false,
}: {
  count?: number;
  offset?: number;
  lead?: boolean;
}) {
  return (
    <div className="skeleton-lines">
      {Array.from({ length: count }, (_, index) => (
        <span className="skeleton-row" key={index} style={wave(index + offset)}>
          {lead && <Bone shape="caption" width="118px" />}
          <Bone width={boneWidth(index * 3, lead ? 70 : 100)} />
        </span>
      ))}
    </div>
  );
}

/** A placeholder for one short inline value, such as a count in a heading. */
export function SkeletonText() {
  return <Bone className="skeleton-inline" width="7ch" />;
}

const GRAPH_GROUPS = [
  { x: 164, y: 40, chips: 2, link: "M124,26 H148 V60 H164" },
  { x: 452, y: 40, chips: 1, link: "M124,26 H576 V40" },
  { x: 164, y: 260, chips: 1, link: "M124,26 H148 V248 H288 V260" },
];

/**
 * A host with its groups of nodes, drawn at the shared graph's own card sizes
 * and connector routes: a trunk from the host, a bus to the far column, and a
 * lane down to the next row. It scales down with the canvas.
 */
export function SkeletonGraph() {
  return (
    <svg className="skeleton-graph" viewBox="-1 -1 702 382">
      <g className="skeleton-graph-links">
        {GRAPH_GROUPS.map((group) => (
          <path key={group.link} d={group.link} />
        ))}
      </g>
      <g className="skeleton-row" style={wave(0)}>
        <rect className="skeleton-graph-host" width="124" height="52" rx="6" />
        <rect className="skeleton-graph-bone" x="12" y="18" width="16" height="16" rx="3" />
        <rect className="skeleton-graph-bone" x="38" y="16" width="58" height="8" rx="4" />
        <rect className="skeleton-graph-bone" x="38" y="30" width="44" height="6" rx="3" />
      </g>
      {GRAPH_GROUPS.map((group, index) => {
        const height = 44 + group.chips * 76;
        return (
          <g className="skeleton-row" key={group.link} style={wave(index + 1)}>
            <rect
              className="skeleton-graph-group"
              x={group.x}
              y={group.y}
              width="248"
              height={height}
              rx="6"
            />
            <path
              className="skeleton-graph-head"
              d={`M${group.x + 6},${group.y} H${group.x + 242} a6,6 0 0 1 6,6 V${group.y + 34} H${group.x} V${group.y + 6} a6,6 0 0 1 6,-6 Z`}
            />
            <rect
              className="skeleton-graph-bone"
              x={group.x + 10}
              y={group.y + 11}
              width="12"
              height="12"
              rx="3"
            />
            <rect
              className="skeleton-graph-bone"
              x={group.x + 30}
              y={group.y + 13}
              width={56 + index * 18}
              height="8"
              rx="4"
            />
            {Array.from({ length: group.chips }, (_, chip) => {
              const x = group.x + 8;
              const y = group.y + 42 + chip * 76;
              const seed = index * 2 + chip;
              return (
                <g key={chip}>
                  <rect
                    className="skeleton-graph-chip"
                    x={x}
                    y={y}
                    width="232"
                    height="70"
                    rx="4"
                  />
                  <rect
                    className="skeleton-graph-bone"
                    x={x + 10}
                    y={y + 10}
                    width="12"
                    height="12"
                    rx="3"
                  />
                  <rect
                    className="skeleton-graph-bone"
                    x={x + 30}
                    y={y + 12}
                    width={span(seed, 110)}
                    height="8"
                    rx="4"
                  />
                  <rect
                    className="skeleton-graph-bone"
                    x={x + 10}
                    y={y + 32}
                    width={span(seed + 3, 140)}
                    height="6"
                    rx="3"
                  />
                  <circle className="skeleton-graph-bone" cx={x + 14} cy={y + 54} r="3.5" />
                  <rect
                    className="skeleton-graph-bone"
                    x={x + 24}
                    y={y + 51}
                    width={span(seed + 5, 64)}
                    height="6"
                    rx="3"
                  />
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="panel-state">
      <Inbox size={22} />
      <h3>{title}</h3>
      {children && <div className="panel-state-content">{children}</div>}
    </div>
  );
}

export function ErrorState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="panel-state panel-state-error">
      <AlertCircle size={22} />
      <h3>Request failed</h3>
      <p>{message}</p>
      {action}
    </div>
  );
}
