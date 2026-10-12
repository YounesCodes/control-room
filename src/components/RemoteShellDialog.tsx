import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type {
  HostCapabilities,
  RemoteShellCatalog,
  RemoteShellProfile,
  SavedConnection,
} from "../types";
import { Modal } from "./Modal";

export function RemoteShellDialog({
  connection,
  onClose,
  onSelect,
  onCapabilities,
}: {
  connection: SavedConnection;
  onClose: () => void;
  onSelect: (shell: RemoteShellProfile | null) => void;
  onCapabilities?: (capabilities: HostCapabilities) => void;
}) {
  const [catalog, setCatalog] = useState<RemoteShellCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState("");
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onCapabilitiesRef = useRef(onCapabilities);
  onCapabilitiesRef.current = onCapabilities;
  useEffect(() => {
    let current = true;
    setError(null);
    setCatalog(null);
    void api
      .discoverRemoteShells(connection.id)
      .then((result) => {
        if (!current) return;
        if (result.capabilities) onCapabilitiesRef.current?.(result.capabilities);
        if (result.platform === "linux") {
          onSelectRef.current(null);
          return;
        }
        setCatalog(result);
        setSelected(result.shells[0]?.id ?? "");
      })
      .catch((caught) => {
        if (current) setError(errorMessage(caught));
      });
    return () => {
      current = false;
    };
  }, [connection.id, attempt]);
  return (
    <Modal title={`Connect to ${connection.displayName}`} onClose={onClose}>
      <div className="form-stack">
        {!catalog && !error && <p role="status">Detecting the host and available shells...</p>}
        {error && (
          <>
            <p className="inline-error" role="alert">
              {error}
            </p>
            <p>
              Shell detection needs noninteractive SSH access. Check your SSH key or agent and host
              trust, then retry. Linux hosts can connect directly and authenticate in the terminal.
            </p>
            <button
              className="secondary-button"
              type="button"
              onClick={() => setAttempt(attempt + 1)}
            >
              Retry detection
            </button>
            <button className="secondary-button" type="button" onClick={() => onSelect(null)}>
              Connect as Linux host
            </button>
          </>
        )}
        {catalog && (
          <>
            <p>Choose a shell installed on this Windows host.</p>
            <label>
              <span>Remote shell</span>
              <select
                aria-label="Remote shell"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                {catalog.shells.map((shell) => (
                  <option key={shell.id} value={shell.id}>
                    {shell.label}
                  </option>
                ))}
              </select>
            </label>
            {!catalog.shells.length && (
              <p role="alert">No supported command-line shells were detected.</p>
            )}
            {catalog.wslError && <p role="status">{catalog.wslError}</p>}
            {catalog.profileError && <p role="status">{catalog.profileError}</p>}
            <small>
              {catalog.windowsTerminalAvailable ? "Windows Terminal is installed. " : ""}
              Shells run here over SSH. Windows Terminal's graphical window requires a desktop
              session.
            </small>
          </>
        )}
        <footer className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          {catalog && (
            <button
              className="primary-button"
              type="button"
              disabled={!selected}
              onClick={() => {
                const shell = catalog.shells.find((item) => item.id === selected);
                if (shell) onSelect(shell);
              }}
            >
              Connect
            </button>
          )}
        </footer>
      </div>
    </Modal>
  );
}
