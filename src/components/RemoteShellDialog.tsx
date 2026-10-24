import { useEffect, useRef, useState } from "react";
import { AlertCircle, LoaderCircle, RefreshCw, SquareTerminal } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import type {
  HostCapabilities,
  RemoteShellCatalog,
  RemoteShellProfile,
  SavedConnection,
} from "../types";
import { HostOsIcon } from "./HostOsIcon";
import { Modal } from "./Modal";

export function shellDescription(id: string): string {
  if (id.startsWith("wsl:")) return "Linux distribution";
  if (id.startsWith("terminal:")) return "Windows Terminal profile";
  if (id === "powershell") return "Built-in Windows shell";
  if (id === "powershell-7") return "PowerShell 7";
  if (id === "cmd") return "Classic command prompt";
  if (id === "git-bash") return "Bash with Git tools";
  if (id === "ssh-default") return "Configured SSH shell";
  return "Installed shell";
}

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
  const [loading, setLoading] = useState(true);
  const onSelectRef = useRef(onSelect);
  const onCapabilitiesRef = useRef(onCapabilities);
  onSelectRef.current = onSelect;
  onCapabilitiesRef.current = onCapabilities;
  useEffect(() => {
    let current = true;
    setError(null);
    setLoading(true);
    void api
      .discoverRemoteShells(connection.id, attempt > 0)
      .then((result) => {
        if (!current) return;
        if (result.capabilities) onCapabilitiesRef.current?.(result.capabilities);
        if (result.platform === "linux") {
          onSelectRef.current(null);
          return;
        }
        setCatalog(result);
        setSelected((value) =>
          result.shells.some((shell) => shell.id === value) ? value : (result.shells[0]?.id ?? ""),
        );
        setLoading(false);
      })
      .catch((caught) => {
        if (current) {
          setError(errorMessage(caught));
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [connection.id, attempt]);
  const groups = catalog
    ? [
        {
          label: "Windows shells",
          shells: catalog.shells.filter(
            (shell) => !shell.id.startsWith("wsl:") && !shell.id.startsWith("terminal:"),
          ),
        },
        {
          label: "WSL distributions",
          shells: catalog.shells.filter((shell) => shell.id.startsWith("wsl:")),
        },
        {
          label: "Terminal profiles",
          shells: catalog.shells.filter((shell) => shell.id.startsWith("terminal:")),
        },
      ].filter((group) => group.shells.length)
    : [];
  const selectedShell = catalog?.shells.find((shell) => shell.id === selected);
  return (
    <Modal title={`Connect to ${connection.displayName}`} onClose={onClose}>
      <div className="remote-shell-body">
        <div className="remote-shell-heading">
          <div className="remote-shell-host">
            <HostOsIcon osId={catalog?.capabilities?.osId} osName={catalog?.capabilities?.osName} />
            <div>
              <strong>
                {catalog?.capabilities?.osName?.replace(/^Microsoft\s+/i, "") ?? "Remote host"}
              </strong>
              <span>Choose a shell for this session</span>
            </div>
          </div>
          {catalog && (
            <button
              className="icon-button"
              type="button"
              disabled={loading}
              aria-label="Refresh available shells"
              title="Refresh available shells"
              onClick={() => setAttempt((value) => value + 1)}
            >
              <RefreshCw size={15} className={loading ? "spinning" : ""} />
            </button>
          )}
        </div>
        {loading && (
          <div className="remote-shell-loading" role="status">
            <LoaderCircle size={18} className="spinning" />
            <span>
              {catalog ? "Refreshing available shells..." : "Finding available shells..."}
            </span>
          </div>
        )}
        {error && (
          <div className="remote-shell-error" role="alert">
            <AlertCircle size={17} />
            <div>
              <strong>Could not detect shells</strong>
              <p>{error}</p>
              <small>Check SSH key or agent access and host trust, then retry.</small>
              <div className="remote-shell-recovery">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Retry
                </button>
                {!catalog && (
                  <button className="secondary-button" type="button" onClick={() => onSelect(null)}>
                    Connect as Linux host
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {!!groups.length && (
          <div className="remote-shell-groups">
            {groups.map((group) => (
              <fieldset className="remote-shell-options" key={group.label} disabled={loading}>
                <legend>{group.label}</legend>
                {group.shells.map((shell) => (
                  <label
                    className={`remote-shell-option${selected === shell.id ? " selected" : ""}`}
                    key={shell.id}
                  >
                    <input
                      type="radio"
                      name="remote-shell"
                      value={shell.id}
                      aria-label={shell.label}
                      checked={selected === shell.id}
                      onClick={(event) => event.currentTarget.focus()}
                      onChange={() => setSelected(shell.id)}
                    />
                    <SquareTerminal size={18} className="remote-shell-mark" aria-hidden="true" />
                    <span className="remote-shell-option-text">
                      <strong>{shell.label.replace(/^WSL:\s*|^Windows Terminal:\s*/i, "")}</strong>
                      <small>{shellDescription(shell.id)}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
        )}
        {catalog && !catalog.shells.length && !loading && (
          <p role="alert">No supported shells were detected.</p>
        )}
        {catalog?.wslError && (
          <p className="remote-shell-note" role="status">
            {catalog.wslError}
          </p>
        )}
        {catalog?.profileError && (
          <p className="remote-shell-note" role="status">
            {catalog.profileError}
          </p>
        )}
      </div>
      <footer className="remote-shell-actions">
        <span>{selectedShell && !loading ? selectedShell.label : "SSH session"}</span>
        <button className="secondary-button" type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={!selectedShell || loading || !!error}
          onClick={() => {
            if (selectedShell) onSelect(selectedShell);
          }}
        >
          Connect
        </button>
      </footer>
    </Modal>
  );
}
