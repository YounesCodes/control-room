import type { ReactNode } from "react";
import { AlertCircle, Inbox } from "lucide-react";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="panel-state" aria-live="polite">
      <span className="spinner" />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="panel-state">
      <Inbox size={22} />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
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
