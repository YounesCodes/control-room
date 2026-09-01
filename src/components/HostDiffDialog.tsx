import { useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { GitCompare, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import {
  diffSummary,
  formatCollectedAt,
  rowDestination,
  rowStateLabel,
  sectionLabel,
  skewWarning,
  statusLabel,
  visibleRows,
} from "../lib/host-diff";
import { connectionTarget } from "../lib/format";
import { Modal } from "./Modal";
import type {
  HostDiff,
  HostDiffProgress,
  HostDiffSection,
  SavedConnection,
  WorkspaceView,
} from "../types";

interface HostDiffDialogProps {
  connections: SavedConnection[];
  onClose: () => void;
  onOpenObject: (connectionId: string, view: WorkspaceView, selectionId: string | null) => void;
}

// Both hosts are read at the same time and each side keeps its own per-section
// status. Nothing here says which host is right, and nothing here changes one.
export function HostDiffDialog({ connections, onClose, onOpenObject }: HostDiffDialogProps) {
  const [leftId, setLeftId] = useState(connections[0]?.id ?? "");
  const [rightId, setRightId] = useState(connections[1]?.id ?? "");
  const [diff, setDiff] = useState<HostDiff | null>(null);
  const [progress, setProgress] = useState<HostDiffProgress | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [differencesOnly, setDifferencesOnly] = useState(true);
  const runIdRef = useRef<string | null>(null);
  runIdRef.current = runId;

  const left = connections.find((connection) => connection.id === leftId) ?? null;
  const right = connections.find((connection) => connection.id === rightId) ?? null;
  const running = Boolean(runId);
  const ready = Boolean(left && right && leftId !== rightId);
  const warning = useMemo(() => (diff ? skewWarning(diff) : null), [diff]);

  async function start() {
    if (running || !ready) return;
    const id = crypto.randomUUID();
    setRunId(id);
    setError(null);
    setDiff(null);
    setProgress(null);
    const channel = new Channel<HostDiffProgress>();
    channel.onmessage = (event) => setProgress(event);
    try {
      setDiff(
        await api.compareTwoHosts(
          { runId: id, leftConnectionId: leftId, rightConnectionId: rightId },
          channel,
        ),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRunId(null);
      setProgress(null);
    }
  }

  async function stop() {
    const id = runIdRef.current;
    if (!id) return;
    try {
      await api.cancelHostDiff(id);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Modal title="Compare two hosts" onClose={onClose}>
      <div className="host-diff-body">
        <p className="host-diff-note">
          Reads the same facts from both hosts at the same time and reports where they differ.
          Read-only: Control Room never changes a host and never says which one is right.
        </p>
        <div className="host-diff-pickers">
          <label>
            <span>Left</span>
            <select
              value={leftId}
              onChange={(event) => setLeftId(event.target.value)}
              disabled={running}
            >
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Right</span>
            <select
              value={rightId}
              onChange={(event) => setRightId(event.target.value)}
              disabled={running}
            >
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="host-diff-note" role="status">
          {ready && left && right
            ? `Will read host facts, systemd units, listening sockets, containers, and filesystems from ${left.displayName} (${connectionTarget(left)}) and ${right.displayName} (${connectionTarget(right)}).`
            : "Choose two different Saved Connections."}
        </p>
        {error && <p className="inline-error">{error}</p>}
        <div className="host-diff-actions">
          {running ? (
            <button className="secondary-button" type="button" onClick={() => void stop()}>
              <X size={15} /> Stop
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              onClick={() => void start()}
              disabled={!ready}
            >
              <GitCompare size={15} /> Compare
            </button>
          )}
          {progress && (
            <span className="host-diff-note" aria-live="polite">
              {sectionLabel(progress.kind)} · {progress.completed} of {progress.total} reads
            </span>
          )}
          {diff && <span className="host-diff-note">{diffSummary(diff)}</span>}
        </div>
        {diff && (
          <>
            <p className="host-diff-note">
              {diff.left.connectionName} read at {formatCollectedAt(diff.left.collectedAt)},{" "}
              {diff.right.connectionName} at {formatCollectedAt(diff.right.collectedAt)}.
            </p>
            {warning && <p className="inline-warning">{warning}</p>}
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={differencesOnly}
                onChange={(event) => setDifferencesOnly(event.target.checked)}
              />{" "}
              Differences only
            </label>
            <div className="host-diff-sections">
              {diff.sections.map((section) => (
                <SectionView
                  key={section.kind}
                  section={section}
                  diff={diff}
                  differencesOnly={differencesOnly}
                  onOpenObject={onOpenObject}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function SectionView({
  section,
  diff,
  differencesOnly,
  onOpenObject,
}: {
  section: HostDiffSection;
  diff: HostDiff;
  differencesOnly: boolean;
  onOpenObject: (connectionId: string, view: WorkspaceView, selectionId: string | null) => void;
}) {
  const rows = visibleRows(section, differencesOnly);
  return (
    <section className="host-diff-section">
      <header>
        <h3>{sectionLabel(section.kind)}</h3>
        <span className={`host-diff-status host-diff-status-${section.leftStatus}`}>
          {statusLabel(section.leftStatus)}
        </span>
        <span aria-hidden="true">/</span>
        <span className={`host-diff-status host-diff-status-${section.rightStatus}`}>
          {statusLabel(section.rightStatus)}
        </span>
        {section.comparable && (
          <span className="host-diff-count">
            {section.differentCount} differing, {section.equalCount} same
          </span>
        )}
      </header>
      {section.note && <p className="inline-warning">{section.note}</p>}
      {section.comparable && !rows.length && (
        <p className="host-diff-count">
          {differencesOnly && section.equalCount
            ? `No differences across ${section.equalCount} compared entries`
            : "Nothing recorded on either host"}
        </p>
      )}
      {!!rows.length && (
        <table>
          <thead>
            <tr>
              <th scope="col">Entry</th>
              <th scope="col">Fact</th>
              <th scope="col">{diff.left.connectionName}</th>
              <th scope="col">{diff.right.connectionName}</th>
              <th scope="col">Open</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const destination = rowDestination(section.kind, row);
              const facts = differencesOnly ? row.facts.filter((fact) => !fact.equal) : row.facts;
              const span = Math.max(1, facts.length);
              return facts.length ? (
                facts.map((fact, index) => (
                  <tr key={`${row.identity}-${fact.name}`}>
                    {index === 0 && (
                      <th scope="row" rowSpan={span}>
                        <code>{row.label}</code>
                        <small className={`host-diff-row-state host-diff-row-${row.state}`}>
                          {rowStateLabel(row.state)}
                        </small>
                      </th>
                    )}
                    <td>{fact.name}</td>
                    <td className="technical">{fact.leftValue ?? "absent"}</td>
                    <td className="technical">{fact.rightValue ?? "absent"}</td>
                    {index === 0 && (
                      <td rowSpan={span}>
                        {destination && (
                          <span className="host-diff-open">
                            <button
                              type="button"
                              onClick={() =>
                                onOpenObject(
                                  diff.left.connectionId,
                                  destination.view,
                                  destination.selectionId,
                                )
                              }
                            >
                              Left
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                onOpenObject(
                                  diff.right.connectionId,
                                  destination.view,
                                  destination.selectionId,
                                )
                              }
                            >
                              Right
                            </button>
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                ))
              ) : (
                <tr key={row.identity}>
                  <th scope="row">
                    <code>{row.label}</code>
                    <small className={`host-diff-row-state host-diff-row-${row.state}`}>
                      {rowStateLabel(row.state)}
                    </small>
                  </th>
                  <td colSpan={3}>No recorded facts</td>
                  <td />
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
