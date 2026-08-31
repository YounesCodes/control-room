import { Check, CircleHelp, Minus, X } from "lucide-react";
import type { ConnectionDiagnostic, ConnectionDiagnosticStatus } from "../types";
import { Modal } from "./Modal";

interface ConnectionDiagnosticsProps {
  diagnostic: ConnectionDiagnostic;
  onClose: () => void;
}

const statusLabels: Record<ConnectionDiagnosticStatus, string> = {
  established: "Established",
  failed: "Failed",
  "not-established": "Not established",
  unknown: "Unknown",
};

function StageIcon({ status }: { status: ConnectionDiagnosticStatus }) {
  if (status === "established") return <Check size={15} aria-hidden="true" />;
  if (status === "failed") return <X size={15} aria-hidden="true" />;
  if (status === "unknown") return <CircleHelp size={15} aria-hidden="true" />;
  return <Minus size={15} aria-hidden="true" />;
}

export function ConnectionDiagnostics({ diagnostic, onClose }: ConnectionDiagnosticsProps) {
  return (
    <Modal title="Connection diagnostics" onClose={onClose}>
      <div className="modal-body connection-diagnostics">
        <p className="diagnostic-summary">{diagnostic.summary}</p>
        <ol className="diagnostic-stages" aria-label="SSH connection stages">
          {diagnostic.stages.map((stage) => (
            <li className={`diagnostic-stage diagnostic-${stage.status}`} key={stage.id}>
              <span className="diagnostic-stage-icon">
                <StageIcon status={stage.status} />
              </span>
              <span>{stage.label}</span>
              <strong>{statusLabels[stage.status]}</strong>
            </li>
          ))}
        </ol>
        <section className="diagnostic-evidence" aria-labelledby="diagnostic-evidence-title">
          <h3 id="diagnostic-evidence-title">Sanitized evidence</h3>
          <code>{diagnostic.detail}</code>
          <p>
            Only reviewed OpenSSH failure patterns are shown. Unknown stages stay unknown, and no
            terminal output or diagnostic record is saved.
          </p>
        </section>
        <section className="diagnostic-related" aria-labelledby="diagnostic-related-title">
          <h3 id="diagnostic-related-title">Related local inspections</h3>
          <p>
            Effective configuration and SSH route inspection become available when those optional
            views are present. Diagnostics never run either inspection automatically.
          </p>
        </section>
      </div>
    </Modal>
  );
}
