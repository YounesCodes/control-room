import { useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FileKey } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { validateConnectionDraft } from "../lib/connection-validation";
import type { SavedConnection, SavedConnectionInput } from "../types";
import { Modal } from "./Modal";

interface ConnectionDialogProps {
  connection?: SavedConnection;
  onClose: () => void;
  onSaved: (connection: SavedConnection) => void;
}

export function ConnectionDialog({ connection, onClose, onSaved }: ConnectionDialogProps) {
  const [displayName, setDisplayName] = useState(connection?.displayName ?? "");
  const [destination, setDestination] = useState(connection?.destination ?? "");
  const [username, setUsername] = useState(connection?.username ?? "");
  const [port, setPort] = useState(connection?.port?.toString() ?? "");
  const [identityFile, setIdentityFile] = useState(connection?.identityFile ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function chooseIdentity() {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Choose an existing SSH private key",
      });
      if (typeof selected === "string") setIdentityFile(selected);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const input: SavedConnectionInput = {
      displayName,
      destination,
      username: username.trim() || null,
      port: port.trim() ? Number(port) : null,
      identityFile: identityFile.trim() || null,
      historyEnabled: connection?.historyEnabled ?? false,
    };
    const validationError = validateConnectionDraft(input);
    if (validationError) {
      setError(validationError);
      setSaving(false);
      return;
    }
    try {
      const saved = connection
        ? await api.updateConnection(connection.id, input)
        : await api.createConnection(input);
      onSaved(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={connection ? "Edit Saved Connection" : "Add Saved Connection"} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label>
          <span>Display name</span>
          <input
            autoFocus
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Debian laptop"
            maxLength={80}
            required
          />
        </label>
        <label>
          <span>SSH destination</span>
          <input
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="192.0.2.10 or an OpenSSH alias"
            maxLength={255}
            required
            spellCheck={false}
          />
          <small>OpenSSH resolves this value using your normal Windows configuration.</small>
        </label>
        <div className="form-row">
          <label>
            <span>Username override</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Optional"
              maxLength={64}
              spellCheck={false}
            />
          </label>
          <label className="port-field">
            <span>Port override</span>
            <input
              value={port}
              onChange={(event) => setPort(event.target.value)}
              type="number"
              min="1"
              max="65535"
              placeholder="SSH default"
            />
          </label>
        </div>
        <label>
          <span>Existing private key override</span>
          <div className="input-action">
            <input
              value={identityFile}
              onChange={(event) => setIdentityFile(event.target.value)}
              placeholder="Use OpenSSH defaults"
              spellCheck={false}
            />
            <button className="secondary-button" type="button" onClick={chooseIdentity}>
              <FileKey size={15} /> Browse
            </button>
          </div>
          <small>
            The key stays in its existing location and is never copied into Control Room.
          </small>
        </label>
        {error && <p className="inline-error">{error}</p>}
        <footer className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? "Saving…" : connection ? "Save changes" : "Add connection"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
