import { useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { tagBadgeStyle } from "../lib/connection-tag-color";
import type { ConnectionGroup, ConnectionTag } from "../types";
import { Modal } from "./Modal";

export function ConnectionGroupsDialog({
  groups,
  tags,
  onGroupsChange,
  onTagsChange,
  onGroupDeleted,
  onTagUpdated,
  onTagDeleted,
  onClose,
}: {
  groups: ConnectionGroup[];
  tags: ConnectionTag[];
  onGroupsChange: (groups: ConnectionGroup[]) => void;
  onTagsChange: (tags: ConnectionTag[]) => void;
  onGroupDeleted: (id: string) => void;
  onTagUpdated: (tag: ConnectionTag) => void;
  onTagDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#3a3a3a");
  const [tagRenameId, setTagRenameId] = useState<string | null>(null);
  const [tagRenameName, setTagRenameName] = useState("");
  const [tagDeleteId, setTagDeleteId] = useState<string | null>(null);
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

  async function createTag(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const tag = await api.createConnectionTag(newTagName, newTagColor);
      onTagsChange([...tags, tag].sort((left, right) => left.name.localeCompare(right.name)));
      setNewTagName("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function renameTag(event: FormEvent) {
    event.preventDefault();
    if (!tagRenameId) return;
    setBusy(true);
    setError(null);
    try {
      const renamed = await api.renameConnectionTag(tagRenameId, tagRenameName);
      onTagUpdated(renamed);
      setTagRenameId(null);
      setTagRenameName("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function setTagColor(tag: ConnectionTag, color: string) {
    setBusy(true);
    setError(null);
    try {
      onTagUpdated(await api.setConnectionTagColor(tag.id, color));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function removeTag(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.deleteConnectionTag(id);
      onTagsChange(tags.filter((tag) => tag.id !== id));
      onTagDeleted(id);
      setTagDeleteId(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Connection groups and tags" onClose={onClose}>
      <div className="connection-groups-dialog">
        <p className="modal-copy">
          Groups and tags organize Saved Connections locally. Deleting a group returns its
          connections to Ungrouped. Deleting a tag removes it from every connection.
        </p>
        <h3 className="connection-organization-heading">Groups</h3>
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
        <h3 className="connection-organization-heading">Tags</h3>
        <form className="connection-tag-create" onSubmit={createTag}>
          <label>
            <span>New tag</span>
            <input
              value={newTagName}
              onChange={(event) => setNewTagName(event.target.value)}
              maxLength={32}
              placeholder="critical"
            />
          </label>
          <label className="connection-tag-color-field">
            <span>Color</span>
            <input
              type="color"
              value={newTagColor}
              onChange={(event) => setNewTagColor(event.target.value)}
            />
          </label>
          <button className="primary-button" type="submit" disabled={busy || !newTagName.trim()}>
            Add tag
          </button>
        </form>
        <div className="connection-tag-manage-list" aria-label="Connection tags">
          {tags.map((tag) => (
            <div className="connection-tag-manage-row" key={tag.id}>
              {tagRenameId === tag.id ? (
                <form onSubmit={renameTag}>
                  <input
                    autoFocus
                    aria-label={`Rename ${tag.name}`}
                    value={tagRenameName}
                    onChange={(event) => setTagRenameName(event.target.value)}
                    maxLength={32}
                  />
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={busy || !tagRenameName.trim()}
                  >
                    Save
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setTagRenameId(null)}
                  >
                    Cancel
                  </button>
                </form>
              ) : tagDeleteId === tag.id ? (
                <div className="connection-tag-delete-confirm">
                  <span>Delete {tag.name} from every connection?</span>
                  <button
                    className="danger-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void removeTag(tag.id)}
                  >
                    Delete tag
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setTagDeleteId(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <span className="connection-tag-badge" style={tagBadgeStyle(tag.color)}>
                    {tag.name}
                  </span>
                  <div>
                    <label className="tag-color-control" title={`Choose a color for ${tag.name}`}>
                      <span className="sr-only">Color for {tag.name}</span>
                      <input
                        type="color"
                        value={tag.color}
                        disabled={busy}
                        onChange={(event) => void setTagColor(tag, event.target.value)}
                      />
                    </label>
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => {
                        setTagRenameId(tag.id);
                        setTagRenameName(tag.name);
                      }}
                      aria-label={`Rename ${tag.name}`}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="icon-button danger-text"
                      type="button"
                      onClick={() => setTagDeleteId(tag.id)}
                      aria-label={`Delete ${tag.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
          {!tags.length && (
            <p className="connection-groups-empty">No tags yet. Add one before assigning it.</p>
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
