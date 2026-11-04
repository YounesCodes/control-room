import type { ReactNode } from "react";

/** Native disclosure semantics with one shared reveal motion for inspector sections. */
export function InspectorDisclosure({
  title,
  children,
  className = "port-disclosure",
  open,
  onToggle,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  open?: boolean;
  onToggle?: (open: boolean) => void;
}) {
  return (
    <details
      className={className}
      open={open}
      onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}
    >
      <summary>{title}</summary>
      <div className="inspector-disclosure-body">{children}</div>
    </details>
  );
}
