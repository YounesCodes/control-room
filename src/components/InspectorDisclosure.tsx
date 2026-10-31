import type { ReactNode } from "react";

/** Native disclosure semantics with one shared reveal motion for inspector sections. */
export function InspectorDisclosure({
  title,
  children,
  className = "port-disclosure",
  open,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  open?: boolean;
}) {
  return (
    <details className={className} open={open}>
      <summary>{title}</summary>
      <div className="inspector-disclosure-body">{children}</div>
    </details>
  );
}
