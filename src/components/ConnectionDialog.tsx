import { useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FileKey, Stethoscope } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { validateConnectionDraft } from "../lib/connection-validation";
import type {
  ConnectionGroup,
  ConnectionTag,
  HostCapabilities,
  SavedConnection,
  SavedConnectionInput,
} from "../types";
import { Modal } from "./Modal";

interface ConnectionDialogProps {
  connection?: SavedConnection;
  groups: ConnectionGroup[];
  knownTags: ConnectionTag[];
  onClose: () => void;
  onSaved: (connection: SavedConnection) => void;
}

export function ConnectionDialog({
  connection,
  groups,
  knownTags,
  onClose,
  onSaved,
}: ConnectionDialogProps) {
  const [displayName, setDisplayName] = useState(connection?.displayName ?? "");
  const [destination, setDestination] = useState(connection?.destination ?? "");
  const [username, setUsername] = useState(connection?.username ?? "");
  const [port, setPort] = useState(connection?.port?.toString() ?? "");
  const [identityFile, setIdentityFile] = useState(connection?.identityFile ?? "");
  const [groupId, setGroupId] = useState(connection?.groupId ?? "");
  const [tagText, setTagText] = useState(connection?.tags.map((tag) => tag.name).join(", ") ?? "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<HostCapabilities | null>(null);

  function input(): SavedConnectionInput {
    return {
      displayName,
      destination,
      username: username.trim(),
      port: port.trim() ? Number(port) : null,
      identityFile: identityFile.trim() || null,
      historyEnabled: connection?.historyEnabled ?? false,
      groupId: groupId || null,
      tagNames: tagText
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    };
  }

  function addKnownTag(name: string) {
    const current = tagText
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (current.some((tag) => tag.toLocaleLowerCase() === name.toLocaleLowerCase())) return;
    setTagText([...current, name].join(", "));
  }

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
    const draft = input();
    const validationError = validateConnectionDraft(draft);
    if (validationError) {
      setError(validationError);
      setSaving(false);
      return;
    }
    try {
      const saved = connection
        ? await api.updateConnection(connection.id, draft)
        : await api.createConnection(draft);
      onSaved(saved);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function testStructuredAccess() {
    const draft = input();
    const validationError = validateConnectionDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      setTestResult(await api.testConnection(draft));
    } catch (caught) {
      setError(
        `Structured access failed: ${errorMessage(caught)}. An interactive terminal may still work with a password.`,
      );
    } finally {
      setTesting(false);
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
            placeholder="e.g. Production server"
            maxLength={80}
            required
          />
        </label>
        <label>
          <span>SSH destination</span>
          <input
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="e.g. 192.0.2.10 or my-server"
            maxLength={255}
            required
            spellCheck={false}
          />
          <small>OpenSSH resolves this value using your normal Windows configuration.</small>
        </label>
        <div className="form-row">
          <label>
            <span>Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="e.g. root"
              maxLength={64}
              required
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
              placeholder="OpenSSH default"
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
        <div className="connection-organization-fields">
          <label>
            <span>Group</span>
            <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              <option value="">Ungrouped</option>
              {groups.map((group) => (
                <option value={group.id} key={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          <span>Tags</span>
          <input
            value={tagText}
            onChange={(event) => setTagText(event.target.value)}
            placeholder="docker, critical"
            maxLength={500}
          />
          <small>Separate up to 12 local tags with commas. Matching ignores case.</small>
        </label>
        {!!knownTags.length && (
          <div className="known-tag-list" aria-label="Existing tags">
            {knownTags.map((tag) => (
              <button type="button" key={tag.id} onClick={() => addKnownTag(tag.name)}>
                {tag.name}
              </button>
            ))}
          </div>
        )}
        {testResult && (
          <p className="inline-message" role="status">
            Noninteractive SSH works. systemd:{" "}
            {testResult.systemdAvailable ? "available" : "not detected"}; journald:{" "}
            {testResult.journaldAvailable ? "available" : "not detected"}; Docker:{" "}
            {testResult.dockerAvailable ? "available" : "not detected"}.
          </p>
        )}
        {error && <p className="inline-error">{error}</p>}
        <footer className="modal-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={testStructuredAccess}
            disabled={saving || testing}
          >
            <Stethoscope size={15} /> {testing ? "Testing…" : "Test structured access"}
          </button>
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
