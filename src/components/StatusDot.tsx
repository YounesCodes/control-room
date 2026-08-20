import type { ConnectionState } from "../types";

export function StatusDot({ state }: { state: ConnectionState | "unknown" }) {
  return <span className={`status-dot status-${state}`} aria-label={state} />;
}
