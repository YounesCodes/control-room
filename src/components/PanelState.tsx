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

/** Varied but stable widths so placeholder text reads as text, not a grid. */
const SKELETON_WIDTHS = [72, 54, 84, 62, 46, 78, 58, 68];

const width = (index: number) =>
  ({ "--skeleton-width": `${SKELETON_WIDTHS[index % SKELETON_WIDTHS.length]}%` }) as CSSProperties;

/**
 * A static placeholder shaped like the content that is loading. It stands
 * where that content will appear, so the surrounding pane or dialog stays
 * usable, and announces `label` as a status for assistive technology.
 *
 * - `rows`: list rows with a mark, a title, and a detail line.
 * - `fields`: label and value pairs, matching inspector fields.
 * - `lines`: lines of text or code.
 * - `control`: a single input or selector.
 * - `canvas`: a graph canvas with a host and its nodes; shows `label` visibly.
 */
export function Skeleton({
  label,
  variant = "rows",
  count = 6,
}: {
  label: string;
  variant?: "rows" | "fields" | "lines" | "control" | "canvas";
  count?: number;
}) {
  const items = variant === "control" ? 1 : variant === "canvas" ? Math.min(count, 4) : count;
  return (
    <div className="skeleton" data-variant={variant} role="status">
      <span className={variant === "canvas" ? "skeleton-label" : "sr-only"}>{label}</span>
      <div className="skeleton-shape" aria-hidden="true">
        {variant === "canvas" && <span className="skeleton-block skeleton-host" />}
        <span className="skeleton-items">
          {Array.from({ length: items }, (_, index) => (
            <span className="skeleton-item" key={index} style={width(index)}>
              {variant === "rows" && <span className="skeleton-mark" />}
              {variant === "fields" && <span className="skeleton-bar skeleton-bar-label" />}
              <span className="skeleton-bar" />
              {variant === "rows" && <span className="skeleton-bar skeleton-bar-detail" />}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

/** A placeholder for one short inline value, such as a count in a heading. */
export function SkeletonText() {
  return <span className="skeleton-bar skeleton-inline" aria-hidden="true" />;
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
