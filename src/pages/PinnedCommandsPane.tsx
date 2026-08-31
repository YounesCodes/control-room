import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, TerminalSquare, Trash2 } from "lucide-react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { PinnedCommandDialog } from "../components/PinnedCommandDialog";
import { EmptyState, ErrorState, LoadingState } from "../components/PanelState";
import { api, errorMessage } from "../lib/api";
import type { PinnedCommand, SavedConnection } from "../types";

export function PinnedCommandsPane({
  connection,
  canInsert,
  onInsert,
}: {
  connection: SavedConnection;
  canInsert: boolean;
  onInsert: (command: string) => void;
}) {
  const [commands, setCommands] = useState<PinnedCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PinnedCommand | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<PinnedCommand | null>(null);
  const [inserting, setInserting] = useState<PinnedCommand | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setCommands(await api.pinnedCommands(connection.id));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [connection.id]);

  const globalCommands = useMemo(
    () => commands.filter((command) => command.connectionId === null),
    [commands],
  );
  const connectionCommands = useMemo(
    () => commands.filter((command) => command.connectionId === connection.id),
    [commands, connection.id],
  );

  async function move(command: PinnedCommand, offset: -1 | 1) {
    const group = command.connectionId ? connectionCommands : globalCommands;
    const index = group.findIndex((item) => item.id === command.id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= group.length) return;
    const reordered = [...group];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setWorkingId(command.id);
    setError(null);
    try {
      await api.reorderPinnedCommands(
        command.connectionId,
        reordered.map((item) => item.id),
      );
      const positions = new Map(reordered.map((item, position) => [item.id, position]));
      setCommands((current) =>
        current
          .map((item) =>
            positions.has(item.id) ? { ...item, position: positions.get(item.id)! } : item,
          )
          .sort(compareCommands),
      );
    } catch (caught) {
      setError(`Could not reorder pinned commands: ${errorMessage(caught)}`);
    } finally {
      setWorkingId(null);
    }
  }

  async function remove() {
    if (!deleting) return;
    setWorkingId(deleting.id);
    setError(null);
    try {
      await api.deletePinnedCommand(deleting.id);
      setCommands((current) => current.filter((command) => command.id !== deleting.id));
      setDeleting(null);
    } catch (caught) {
      setError(`Could not delete pinned command: ${errorMessage(caught)}`);
    } finally {
      setWorkingId(null);
    }
  }

  function saved(command: PinnedCommand) {
    setCommands((current) => {
      const found = current.some((item) => item.id === command.id);
      return (
        found
          ? current.map((item) => (item.id === command.id ? command : item))
          : [...current, command]
      ).sort(compareCommands);
    });
    setEditing(undefined);
  }

  if (loading && !commands.length) return <LoadingState label="Loading pinned commands…" />;
  if (error && !commands.length) {
    return (
      <ErrorState message={error} action={<button onClick={() => void load()}>Retry</button>} />
    );
  }

  return (
    <section className="feature-page pinned-commands-page">
      <header className="page-heading">
        <div>
          <h2>Pinned Commands</h2>
          <p>Reusable terminal text for every connection or only {connection.displayName}.</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setEditing(null)}>
          <Plus size={15} /> Add command
        </button>
      </header>
      {!canInsert && (
        <p className="inline-warning">
          Reconnect this Workspace’s Terminal Session before inserting a command.
        </p>
      )}
      {error && <p className="inline-error">{error}</p>}
      {!commands.length ? (
        <EmptyState title="No pinned commands">
          Keep frequently used one-line commands close without running them automatically.
        </EmptyState>
      ) : (
        <div className="pinned-command-groups">
          <CommandGroup
            title="Every Saved Connection"
            commands={globalCommands}
            canInsert={canInsert}
            workingId={workingId}
            onInsert={setInserting}
            onEdit={(command) => setEditing(command)}
            onDelete={setDeleting}
            onMove={move}
          />
          <CommandGroup
            title={connection.displayName}
            commands={connectionCommands}
            canInsert={canInsert}
            workingId={workingId}
            onInsert={setInserting}
            onEdit={(command) => setEditing(command)}
            onDelete={setDeleting}
            onMove={move}
          />
        </div>
      )}
      {editing !== undefined && (
        <PinnedCommandDialog
          connection={connection}
          command={editing}
          onClose={() => setEditing(undefined)}
          onSaved={saved}
        />
      )}
      {inserting && (
        <Modal title={`Insert ${inserting.name}?`} onClose={() => setInserting(null)}>
          <div className="pinned-insert-confirmation">
            <p>
              Control Room cannot verify that the current prompt is empty. This appends the exact
              text below to the active terminal and does not press Enter.
            </p>
            <pre>{inserting.command}</pre>
            <footer className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setInserting(null)}>
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  onInsert(inserting.command);
                  setInserting(null);
                }}
              >
                Insert without Enter
              </button>
            </footer>
          </div>
        </Modal>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete pinned command"
          message={`Delete “${deleting.name}”? This does not affect terminal history.`}
          confirmLabel="Delete command"
          danger
          onConfirm={() => void remove()}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

function CommandGroup({
  title,
  commands,
  canInsert,
  workingId,
  onInsert,
  onEdit,
  onDelete,
  onMove,
}: {
  title: string;
  commands: PinnedCommand[];
  canInsert: boolean;
  workingId: string | null;
  onInsert: (command: PinnedCommand) => void;
  onEdit: (command: PinnedCommand) => void;
  onDelete: (command: PinnedCommand) => void;
  onMove: (command: PinnedCommand, offset: -1 | 1) => void;
}) {
  return (
    <section className="pinned-command-group">
      <header>
        <h3>{title}</h3>
        <span>{commands.length}</span>
      </header>
      {!commands.length ? (
        <p className="pinned-command-group-empty">No commands in this scope.</p>
      ) : (
        <ol>
          {commands.map((command, index) => (
            <li key={command.id}>
              <div className="pinned-command-copy">
                <strong>{command.name}</strong>
                <code>{command.command}</code>
              </div>
              <div className="row-actions">
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Move ${command.name} up`}
                  title="Move up"
                  disabled={index === 0 || workingId !== null}
                  onClick={() => onMove(command, -1)}
                >
                  <ArrowUp size={15} />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Move ${command.name} down`}
                  title="Move down"
                  disabled={index === commands.length - 1 || workingId !== null}
                  onClick={() => onMove(command, 1)}
                >
                  <ArrowDown size={15} />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Edit ${command.name}`}
                  title="Edit"
                  onClick={() => onEdit(command)}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="icon-button danger-text"
                  type="button"
                  aria-label={`Delete ${command.name}`}
                  title="Delete"
                  onClick={() => onDelete(command)}
                >
                  <Trash2 size={15} />
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!canInsert}
                  title={canInsert ? "Review insertion" : "Reconnect the terminal first"}
                  onClick={() => onInsert(command)}
                >
                  <TerminalSquare size={14} /> Insert
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function compareCommands(left: PinnedCommand, right: PinnedCommand): number {
  if (left.connectionId === right.connectionId) {
    return left.position - right.position || left.name.localeCompare(right.name);
  }
  return left.connectionId === null ? -1 : 1;
}
