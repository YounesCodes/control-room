import { useCallback, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { CredentialDialog } from "../components/CredentialDialog";
import { EmptyState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import {
  MAX_HOSTS,
  buildRows,
  cellStatusLabel,
  digestNote,
  inventoryNotes,
  rowSummary,
  selectionKey,
  shortImageId,
  unpairedContainers,
  verdictLabel,
} from "../lib/image-drift";
import type { HostSlot } from "../lib/image-drift";
import type { HostImageInventory, SavedConnection } from "../types";

// Hosts are read a couple at a time. The per-connection limiter already bounds
// each host; this only keeps a six-host run from opening six SSH processes at
// once.
const READ_CONCURRENCY = 2;

interface SlotState {
  status: HostSlot["status"];
  inventory: HostImageInventory | null;
  error: string | null;
}

const idleSlot: SlotState = { status: "idle", inventory: null, error: null };

export function ImagesPane({
  connection,
  connections,
  selectedConnectionIds,
  onSelectedConnectionIdsChange,
}: {
  connection: SavedConnection;
  connections: SavedConnection[];
  selectedConnectionIds: string[];
  onSelectedConnectionIdsChange: (ids: string[]) => void;
}) {
  const [slots, setSlots] = useState<Record<string, SlotState>>({});
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [sudoConnectionId, setSudoConnectionId] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const runRef = useRef(0);

  const hostIds = useMemo(() => {
    const others = selectedConnectionIds.filter((id) => id !== connection.id);
    return [connection.id, ...others].slice(0, MAX_HOSTS);
  }, [connection.id, selectedConnectionIds]);

  const hostSlots: HostSlot[] = useMemo(
    () =>
      hostIds.map((id) => {
        const slot = slots[id] ?? idleSlot;
        return {
          connectionId: id,
          displayName: connections.find((entry) => entry.id === id)?.displayName ?? id,
          status: slot.status,
          inventory: slot.inventory,
          error: slot.error,
        };
      }),
    [hostIds, slots, connections],
  );

  const readHost = useCallback(
    async (connectionId: string, run: number, sudoPassword: string | null = null) => {
      setSlots((current) => ({
        ...current,
        [connectionId]: { status: "running", inventory: null, error: null },
      }));
      try {
        const inventory = await api.collectHostImages(connectionId, sudoPassword);
        if (run !== runRef.current) return;
        setSlots((current) => ({
          ...current,
          [connectionId]: { status: "collected", inventory, error: null },
        }));
      } catch (caught) {
        if (run !== runRef.current) return;
        setSlots((current) => ({
          ...current,
          [connectionId]: { status: "failed", inventory: null, error: errorMessage(caught) },
        }));
      }
    },
    [],
  );

  const readAll = useCallback(async () => {
    const run = ++runRef.current;
    setReading(true);
    setConfirmed([]);
    setSelections({});
    const queue = [...hostIds];
    const workers = Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next || run !== runRef.current) return;
        await readHost(next, run);
      }
    });
    await Promise.all(workers);
    if (run === runRef.current) setReading(false);
  }, [hostIds, readHost]);

  const rows = useMemo(() => buildRows(hostSlots, selections), [hostSlots, selections]);
  const collectedHosts = hostSlots.filter((slot) => slot.status === "collected").length;

  function toggleHost(id: string, include: boolean) {
    const others = selectedConnectionIds.filter((entry) => entry !== id && entry !== connection.id);
    onSelectedConnectionIdsChange(include ? [...others, id] : others);
  }

  function confirmAllUnambiguous() {
    setConfirmed(
      rows
        .filter((row) => row.cells.every((cell) => cell.status !== "ambiguous"))
        .map((row) => row.key),
    );
  }

  const others = connections.filter((entry) => entry.id !== connection.id);

  return (
    <section className="feature-page images-page">
      <header className="page-heading">
        <div>
          <h2>Container image drift</h2>
          <p>
            Compares Compose workloads across selected hosts. Matches are suggested, never applied
            on your behalf, and Control Room changes no image or container.
          </p>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => void readAll()}
          disabled={reading}
          aria-label="Read selected hosts"
        >
          <RefreshCw size={16} className={reading ? "spinning" : ""} />
        </button>
      </header>

      <div className="images-hosts">
        <p className="images-anchor">
          Anchor host: <strong>{connection.displayName}</strong>
        </p>
        {others.length ? (
          <ul>
            {others.map((entry) => {
              const included = hostIds.includes(entry.id);
              const atLimit = !included && hostIds.length >= MAX_HOSTS;
              return (
                <li key={entry.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={included}
                      disabled={atLimit}
                      onChange={(event) => toggleHost(entry.id, event.target.checked)}
                    />
                    <span>{entry.displayName}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="images-note">Save another connection to compare against.</p>
        )}
        <small className="images-note">At most {MAX_HOSTS} hosts in one comparison.</small>
      </div>

      <ul className="images-host-status">
        {hostSlots.map((slot) => (
          <li key={slot.connectionId}>
            <strong>{slot.displayName}</strong>
            <span className={`images-state images-state-${slot.status}`}>{slot.status}</span>
            {slot.error && <small>{slot.error}</small>}
            {slot.error?.toLowerCase().includes("permission denied") && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => setSudoConnectionId(slot.connectionId)}
              >
                Retry with sudo
              </button>
            )}
            {inventoryNotes(slot).map((note) => (
              <small key={note}>{note}</small>
            ))}
          </li>
        ))}
      </ul>

      {!rows.length && (
        <EmptyState title={collectedHosts ? "No Compose workloads found" : "Nothing read yet"}>
          {collectedHosts
            ? "Only containers with a validated Compose project and service can be paired in this version."
            : "Select hosts, then read them."}
        </EmptyState>
      )}

      {Boolean(rows.length) && (
        <div className="images-rows">
          <div className="images-rows-actions">
            <button className="secondary-button" type="button" onClick={confirmAllUnambiguous}>
              Confirm all unambiguous matches
            </button>
            <small className="images-note">
              A comparison appears once you confirm the match for that workload.
            </small>
          </div>
          {rows.map((row) => {
            const isConfirmed = confirmed.includes(row.key);
            return (
              <article className="images-row" key={row.key}>
                <header>
                  <h3>{row.key}</h3>
                  <label>
                    <input
                      type="checkbox"
                      checked={isConfirmed}
                      onChange={(event) =>
                        setConfirmed((current) =>
                          event.target.checked
                            ? [...current, row.key]
                            : current.filter((key) => key !== row.key),
                        )
                      }
                    />
                    <span>Match confirmed</span>
                  </label>
                </header>
                {isConfirmed ? (
                  <>
                    <p className={`images-verdict images-verdict-${row.verdict}`}>
                      {verdictLabel(row.verdict)}
                    </p>
                    <p className="images-note">{rowSummary(row)}</p>
                    {Boolean(digestNote(row)) && <p className="images-note">{digestNote(row)}</p>}
                  </>
                ) : (
                  <p className="images-note">
                    Confirm this match to compare. Compose project and service alone do not prove
                    two containers have the same role.
                  </p>
                )}
                <ul className="images-cells">
                  {row.cells.map((cell) => {
                    const host = hostSlots.find((slot) => slot.connectionId === cell.connectionId);
                    return (
                      <li key={cell.connectionId}>
                        <strong>{host?.displayName ?? cell.connectionId}</strong>
                        <span className="images-cell-status">{cellStatusLabel(cell)}</span>
                        {cell.status === "ambiguous" ? (
                          <select
                            aria-label={`Instance for ${row.key} on ${host?.displayName ?? cell.connectionId}`}
                            value=""
                            onChange={(event) =>
                              setSelections((current) => ({
                                ...current,
                                [selectionKey(row.key, cell.connectionId)]: event.target.value,
                              }))
                            }
                          >
                            <option value="">Pick an instance</option>
                            {cell.candidates.map((candidate) => (
                              <option key={candidate.container.id} value={candidate.container.id}>
                                {candidate.container.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          cell.selected && (
                            <>
                              <code>
                                {cell.selected.recordedReference ?? cell.selected.container.image}
                              </code>
                              <code>{shortImageId(cell.selected.imageId)}</code>
                              <small>
                                {cell.selected.repoDigests.length
                                  ? `digest ${shortImageId(cell.selected.repoDigests[0])}`
                                  : "no registry digest"}
                              </small>
                            </>
                          )
                        )}
                      </li>
                    );
                  })}
                </ul>
              </article>
            );
          })}
        </div>
      )}

      {hostSlots.some((slot) => unpairedContainers(slot).length > 0) && (
        <div className="images-unpaired">
          <h3>Not paired</h3>
          {hostSlots.map((slot) => {
            const unpaired = unpairedContainers(slot);
            if (!unpaired.length) return null;
            return (
              <p key={slot.connectionId} className="images-note">
                {slot.displayName}: {unpaired.map((fact) => fact.container.name).join(", ")}
              </p>
            );
          })}
          <small className="images-note">
            These containers have no validated Compose project and service, so this version leaves
            them unpaired instead of guessing from their names.
          </small>
        </div>
      )}

      {sudoConnectionId && (
        <CredentialDialog
          connectionLabel={
            connections.find((entry) => entry.id === sudoConnectionId)?.displayName ??
            sudoConnectionId
          }
          onClose={() => setSudoConnectionId(null)}
          onSubmit={async (password) => {
            const id = sudoConnectionId;
            setSudoConnectionId(null);
            await readHost(id, runRef.current, password);
          }}
        />
      )}
    </section>
  );
}
