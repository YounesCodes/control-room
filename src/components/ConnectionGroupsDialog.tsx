import { useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import type { ConnectionGroup } from "../types";
import { Modal } from "./Modal";

export function ConnectionGroupsDialog({
  groups,
  onGroupsChange,
  onGroupDeleted,
  onClose,
}: {
  groups: ConnectionGroup[];
  onGroupsChange: (groups: ConnectionGroup[]) => void;
  onGroupDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const group = await api.createConnectionGroup(newName);
      onGroupsChange([...groups, group]);
      setNewName("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!renameId) return;
    setBusy(true);
    setError(null);
    try {
      const renamed = await api.renameConnectionGroup(renameId, renameName);
      onGroupsChange(groups.map((group) => (group.id === renamed.id ? renamed : group)));
      setRenameId(null);
      setRenameName("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.deleteConnectionGroup(id);
      onGroupsChange(groups.filter((group) => group.id !== id));
      onGroupDeleted(id);
      setDeleteId(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function move(id: string, direction: "up" | "down") {
    setBusy(true);
    setError(null);
    try {
      onGroupsChange(await api.moveConnectionGroup(id, direction));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Connection groups" onClose={onClose}>
      <div className="connection-groups-dialog">
        <p className="modal-copy">
          Groups organize Saved Connections locally. Deleting a group returns its connections to
          Ungrouped.
        </p>
        <form className="connection-group-create" onSubmit={create}>
          <label>
            <span>New group</span>
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              maxLength={60}
              placeholder="Homelab"
            />
          </label>
          <button className="primary-button" type="submit" disabled={busy || !newName.trim()}>
            Add group
          </button>
        </form>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="connection-group-list" aria-label="Connection groups">
          {groups.map((group, index) => (
            <div className="connection-group-manage-row" key={group.id}>
              {renameId === group.id ? (
                <form onSubmit={rename}>
                  <input
                    autoFocus
                    aria-label={`Rename ${group.name}`}
                    value={renameName}
                    onChange={(event) => setRenameName(event.target.value)}
                    maxLength={60}
                  />
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={busy || !renameName.trim()}
                  >
                    Save
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setRenameId(null)}
                  >
                    Cancel
                  </button>
                </form>
              ) : deleteId === group.id ? (
                <div className="connection-group-delete-confirm">
                  <span>Delete {group.name}?</span>
                  <button
                    className="danger-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(group.id)}
                  >
                    Delete group
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setDeleteId(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <span>{group.name}</span>
                  <div>
                    <button
                      className="icon-button"
                      type="button"
                      disabled={busy || index === 0}
                      onClick={() => void move(group.id, "up")}
                      aria-label={`Move ${group.name} up`}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      disabled={busy || index === groups.length - 1}
                      onClick={() => void move(group.id, "down")}
                      aria-label={`Move ${group.name} down`}
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => {
                        setRenameId(group.id);
                        setRenameName(group.name);
                      }}
                      aria-label={`Rename ${group.name}`}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="icon-button danger-text"
                      type="button"
                      onClick={() => setDeleteId(group.id)}
                      aria-label={`Delete ${group.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
          {!groups.length && (
            <p className="connection-groups-empty">No groups yet. Ungrouped is always available.</p>
          )}
        </div>
        <footer className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </Modal>
  );
}
