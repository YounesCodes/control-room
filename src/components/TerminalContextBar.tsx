import { useEffect, useState } from "react";
import { Boxes, FileClock, Server, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import {
  contextKindLabel,
  resolveDockerContainer,
  resolveSystemdUnit,
  unresolvedMessage,
} from "../lib/terminal-context";
import type { LogSourceSelection, SavedConnection, TerminalContextReference } from "../types";

interface TerminalContextBarProps {
  connection: SavedConnection;
  reference: TerminalContextReference;
  onDismiss: () => void;
  onOpenSystemd: (unitId: string) => void;
  onOpenContainer: (containerId: string) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}

// The bar reads only from the last reported Enhanced History command. Every
// action re-reads the live host list first, so a removed or renamed object
// reports that instead of opening a stale view.
export function TerminalContextBar({
  connection,
  reference,
  onDismiss,
  onOpenSystemd,
  onOpenContainer,
  onViewLogs,
}: TerminalContextBarProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setMessage(null);
  }, [reference]);

  async function withFreshObject(open: (resolvedId: string) => void) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (reference.kind === "systemdUnit") {
        const units = await api.listServices(connection.id);
        const resolution = resolveSystemdUnit(units, reference.id);
        if (resolution.status === "resolved") open(resolution.match.id);
        else setMessage(unresolvedMessage(reference, resolution));
        return;
      }
      const containers = await api.listContainers(connection.id);
      const resolution = resolveDockerContainer(containers, reference.id);
      if (resolution.status === "resolved") open(resolution.match.id);
      else setMessage(unresolvedMessage(reference, resolution));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const isUnit = reference.kind === "systemdUnit";
  const ObjectIcon = isUnit ? Server : Boxes;

  return (
    <div className="terminal-context-bar" role="region" aria-label="Terminal context">
      <ObjectIcon size={14} strokeWidth={1.8} aria-hidden="true" />
      <span className="terminal-context-object">
        <small>{contextKindLabel(reference)}</small>
        <code>{reference.id}</code>
      </span>
      <code className="terminal-context-source" title={reference.sourceCommand}>
        {reference.sourceCommand}
      </code>
      <span className="terminal-context-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void withFreshObject((id) => (isUnit ? onOpenSystemd(id) : onOpenContainer(id)))
          }
        >
          <ObjectIcon size={13} strokeWidth={1.8} aria-hidden="true" />
          {isUnit ? "Open in Systemd" : "Inspect container"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void withFreshObject((id) => onViewLogs({ type: isUnit ? "systemd" : "docker", id }))
          }
        >
          <FileClock size={13} strokeWidth={1.8} aria-hidden="true" />
          Follow logs
        </button>
      </span>
      {message && (
        <span className="terminal-context-message" role="status">
          {message}
        </span>
      )}
      <button
        className="terminal-context-dismiss"
        type="button"
        onClick={onDismiss}
        aria-label="Clear terminal context"
        title="Clear terminal context"
      >
        <X size={13} />
      </button>
    </div>
  );
}
