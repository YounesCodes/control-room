import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../lib/api";
import type { PinnedCommand, PinnedCommandInput, SavedConnection } from "../types";
import { Modal } from "./Modal";

export function PinnedCommandDialog({
  connection,
  command,
  onClose,
  onSaved,
}: {
  connection: SavedConnection;
  command: PinnedCommand | null;
  onClose: () => void;
  onSaved: (command: PinnedCommand) => void;
}) {
  const [name, setName] = useState(command?.name ?? "");
  const [text, setText] = useState(command?.command ?? "");
  const [scope, setScope] = useState<"global" | "connection">(
    command?.connectionId ? "connection" : "global",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const input: PinnedCommandInput = {
      name,
      command: text,
      connectionId: scope === "connection" ? connection.id : null,
    };
    setSaving(true);
    setError(null);
    try {
      const saved = command
        ? await api.updatePinnedCommand(command.id, input)
        : await api.createPinnedCommand(input);
      onSaved(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={command ? "Edit pinned command" : "Add pinned command"} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label>
          <span>Name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder="Disk usage"
            required
          />
        </label>
        <label>
          <span>Command</span>
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={4096}
            placeholder="df -h"
            spellCheck={false}
            required
          />
          <small>One line only. Control Room inserts this text without Enter.</small>
        </label>
        <label>
          <span>Available in</span>
          <select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
            <option value="global">Every Saved Connection</option>
            <option value="connection">Only {connection.displayName}</option>
          </select>
        </label>
        <p className="inline-warning">
          Commands are ordinary local data. Do not store passwords, tokens, or private keys here.
        </p>
        {error && <p className="inline-error">{error}</p>}
        <footer className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? "Saving…" : command ? "Save changes" : "Add command"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
