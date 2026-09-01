import { useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Play, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import {
  canRun,
  factValue,
  isReadable,
  mergeResult,
  resultColumns,
  stateLabel,
  summarizeRun,
  validateParameter,
} from "../lib/cross-host";
import { connectionTarget } from "../lib/format";
import { Modal } from "./Modal";
import type { CrossHostOperation, CrossHostResult, SavedConnection } from "../types";

interface CrossHostDialogProps {
  connections: SavedConnection[];
  onClose: () => void;
}

// Targets are chosen one by one and shown back before anything runs. A group or
// a tag can narrow the list on screen, but it never becomes the target set on
// its own.
export function CrossHostDialog({ connections, onClose }: CrossHostDialogProps) {
  const [operations, setOperations] = useState<CrossHostOperation[]>([]);
  const [operationId, setOperationId] = useState("");
  const [parameter, setParameter] = useState("");
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [results, setResults] = useState<CrossHostResult[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  runIdRef.current = runId;

  useEffect(() => {
    void api
      .listCrossHostOperations()
      .then((items) => {
        setOperations(items);
        setOperationId((current) => current || (items[0]?.id ?? ""));
      })
      .catch((caught: unknown) => setError(errorMessage(caught)));
  }, []);

  const operation = operations.find((item) => item.id === operationId) ?? null;
  const parameterError = validateParameter(operation, parameter);
  const targets = useMemo(
    () => connections.filter((connection) => targetIds.includes(connection.id)),
    [connections, targetIds],
  );
  const columns = resultColumns(operation);
  const running = Boolean(runId);

  function toggleTarget(id: string) {
    setTargetIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  async function start() {
    if (running || !operation || !canRun(operation, parameter, targetIds)) return;
    const id = crypto.randomUUID();
    setRunId(id);
    setError(null);
    setResults([]);
    const progress = new Channel<CrossHostResult>();
    progress.onmessage = (incoming) => {
      setResults((current) => mergeResult(current, incoming));
    };
    try {
      const final = await api.runCrossHostInspection(
        {
          runId: id,
          operationId: operation.id,
          parameter: operation.parameter ? parameter.trim() : null,
          connectionIds: targetIds,
        },
        progress,
      );
      setResults(final);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRunId(null);
    }
  }

  async function cancel() {
    const id = runIdRef.current;
    if (!id) return;
    try {
      await api.cancelCrossHostInspection(id);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Modal title="Cross-host inspection" onClose={onClose}>
      <div className="cross-host-body">
        <p className="cross-host-note">
          One predefined read-only inspection, run against the Saved Connections you tick below.
          Control Room never runs a command you type here, and never changes a host.
        </p>
        <label>
          <span>Inspection</span>
          <select
            value={operationId}
            onChange={(event) => {
              setOperationId(event.target.value);
              setParameter("");
              setResults([]);
            }}
            disabled={running}
          >
            {operations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {operation && <p className="cross-host-note">{operation.description}</p>}
        {operation?.parameter && (
          <label>
            <span>{operation.parameter.label}</span>
            <input
              value={parameter}
              onChange={(event) => setParameter(event.target.value)}
              placeholder={operation.parameter.placeholder}
              disabled={running}
            />
          </label>
        )}
        {parameter && parameterError && <p className="inline-error">{parameterError}</p>}
        <fieldset className="cross-host-targets">
          <legend>Targets</legend>
          {connections.map((connection) => (
            <label key={connection.id} className="checkbox-label">
              <input
                type="checkbox"
                checked={targetIds.includes(connection.id)}
                onChange={() => toggleTarget(connection.id)}
                disabled={running}
              />{" "}
              {connection.displayName}
              <small>{connectionTarget(connection)}</small>
            </label>
          ))}
          {!connections.length && <p className="cross-host-note">No Saved Connections yet.</p>}
        </fieldset>
        <p className="cross-host-note" role="status">
          {targets.length
            ? `Will read ${columns.join(", ")} from ${targets.length} host${
                targets.length === 1 ? "" : "s"
              }: ${targets.map((connection) => connection.displayName).join(", ")}.`
            : "Tick at least one Saved Connection."}
        </p>
        {error && <p className="inline-error">{error}</p>}
        <div className="cross-host-actions">
          {running ? (
            <button className="secondary-button" type="button" onClick={() => void cancel()}>
              <X size={15} /> Stop
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              onClick={() => void start()}
              disabled={!canRun(operation, parameter, targetIds)}
            >
              <Play size={15} /> Run inspection
            </button>
          )}
          {!!results.length && <span className="cross-host-note">{summarizeRun(results)}</span>}
        </div>
        {!!results.length && (
          <div className="cross-host-results">
            <table>
              <thead>
                <tr>
                  <th scope="col">Host</th>
                  <th scope="col">State</th>
                  {columns.map((column) => (
                    <th scope="col" key={column}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr key={result.connectionId}>
                    <th scope="row">{result.connectionName}</th>
                    <td>
                      <span className={`cross-host-state cross-host-state-${result.state}`}>
                        {stateLabel(result.state)}
                      </span>
                      {result.message && <small>{result.message}</small>}
                    </td>
                    {columns.map((column) => (
                      <td key={column} className="technical">
                        {isReadable(result.state)
                          ? (factValue(result, column) ?? "unavailable")
                          : "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
