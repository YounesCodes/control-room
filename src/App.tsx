import { useEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
  FileClock,
  Gauge,
  History,
  MoreHorizontal,
  Plus,
  Search,
  Server,
  Settings,
  SquareTerminal,
  X,
} from "lucide-react";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { ErrorState, LoadingState } from "./components/PanelState";
import { StatusDot } from "./components/StatusDot";
import { TerminalPane } from "./components/TerminalPane";
import { api, errorMessage } from "./lib/api";
import { connectionTarget } from "./lib/format";
import { DockerPane } from "./pages/DockerPane";
import { HistoryPane } from "./pages/HistoryPane";
import { LogsPane } from "./pages/LogsPane";
import { OverviewPane } from "./pages/OverviewPane";
import { ServicesPane } from "./pages/ServicesPane";
import { SettingsPane } from "./pages/SettingsPane";
import type {
  AppSettings,
  ConnectionState,
  EnvironmentInfo,
  SavedConnection,
  Workspace,
  WorkspaceView,
} from "./types";

const defaultSettings: AppSettings = {
  terminalFontFamily: "Cascadia Mono, Consolas, monospace",
  terminalFontSize: 14,
  terminalScrollback: 10_000,
  defaultLogTail: 200,
  globalHistoryEnabled: true,
};

const emptyEnvironment: EnvironmentInfo = {
  sshPath: null,
  sshConfigPath: "%USERPROFILE%\\.ssh\\config",
  sshAgentAvailable: false,
  platformSupported: true,
};

const navigation: { id: WorkspaceView; label: string; icon: typeof Gauge }[] = [
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "services", label: "Services", icon: Server },
  { id: "docker", label: "Docker", icon: Boxes },
  { id: "logs", label: "Logs", icon: FileClock },
  { id: "history", label: "History", icon: History },
];

export function App() {
  const [connections, setConnections] = useState<SavedConnection[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [settings, setSettings] = useState(defaultSettings);
  const [environment, setEnvironment] = useState(emptyEnvironment);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hostSearch, setHostSearch] = useState("");
  const [dialogConnection, setDialogConnection] = useState<SavedConnection | "new" | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const hostSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let current = true;
    void Promise.all([api.listConnections(), api.settings(), api.environment()])
      .then(([savedConnections, savedSettings, detectedEnvironment]) => {
        if (!current) return;
        setConnections(savedConnections);
        setSettings(savedSettings);
        setEnvironment(detectedEnvironment);
      })
      .catch((caught) => current && setBootError(errorMessage(caught)))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, []);

  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const activeConnection = activeWorkspace
    ? (connections.find((connection) => connection.id === activeWorkspace.connectionId) ?? null)
    : null;

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        hostSearchRef.current?.focus();
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "t" && activeWorkspace) {
        event.preventDefault();
        updateWorkspace(activeWorkspace.id, { view: "terminal" });
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "w" && activeWorkspace) {
        event.preventDefault();
        void closeWorkspace(activeWorkspace.id);
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "r" && activeWorkspace) {
        event.preventDefault();
        updateWorkspace(activeWorkspace.id, {
          reconnectToken: activeWorkspace.reconnectToken + 1,
        });
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [activeWorkspace]);

  const filteredConnections = useMemo(() => {
    const query = hostSearch.trim().toLowerCase();
    if (!query) return connections;
    return connections.filter(
      (connection) =>
        connection.displayName.toLowerCase().includes(query) ||
        connectionTarget(connection).toLowerCase().includes(query),
    );
  }, [connections, hostSearch]);

  function updateWorkspace(id: string, patch: Partial<Workspace>) {
    setWorkspaces((current) =>
      current.map((workspace) => (workspace.id === id ? { ...workspace, ...patch } : workspace)),
    );
  }

  function openConnection(connection: SavedConnection, forceNew = false) {
    setSettingsOpen(false);
    if (!forceNew) {
      const existing = [...workspaces]
        .reverse()
        .find((workspace) => workspace.connectionId === connection.id);
      if (existing) {
        setActiveWorkspaceId(existing.id);
        return;
      }
    }
    const workspace: Workspace = {
      id: crypto.randomUUID(),
      connectionId: connection.id,
      sessionId: null,
      state: "connecting",
      reason: null,
      view: "terminal",
      historyPaused: false,
      reconnectToken: 0,
    };
    setWorkspaces((current) => [...current, workspace]);
    setActiveWorkspaceId(workspace.id);
  }

  async function closeWorkspace(id: string) {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) return;
    if (
      workspace.sessionId &&
      !window.confirm("Disconnect the active SSH session and close this Workspace?")
    ) {
      return;
    }
    if (workspace.sessionId) await api.closeSession(workspace.sessionId).catch(() => undefined);
    const index = workspaces.findIndex((item) => item.id === id);
    const remaining = workspaces.filter((item) => item.id !== id);
    setWorkspaces(remaining);
    if (activeWorkspaceId === id) {
      setActiveWorkspaceId(remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
    }
  }

  async function deleteConnection(connection: SavedConnection) {
    if (!window.confirm(`Delete the Saved Connection “${connection.displayName}” and its History?`))
      return;
    const related = workspaces.filter((workspace) => workspace.connectionId === connection.id);
    for (const workspace of related) {
      if (workspace.sessionId) await api.closeSession(workspace.sessionId).catch(() => undefined);
    }
    await api.deleteConnection(connection.id);
    setConnections((current) => current.filter((item) => item.id !== connection.id));
    setWorkspaces((current) => current.filter((item) => item.connectionId !== connection.id));
    if (related.some((workspace) => workspace.id === activeWorkspaceId)) setActiveWorkspaceId(null);
  }

  function saveConnection(saved: SavedConnection) {
    setConnections((current) => {
      const exists = current.some((connection) => connection.id === saved.id);
      const next = exists
        ? current.map((connection) => (connection.id === saved.id ? saved : connection))
        : [...current, saved];
      return next.sort((left, right) => left.displayName.localeCompare(right.displayName));
    });
    setDialogConnection(null);
  }

  function aggregateState(connectionId: string): ConnectionState | "unknown" {
    const related = workspaces.filter((workspace) => workspace.connectionId === connectionId);
    if (related.some((workspace) => workspace.state === "connected")) return "connected";
    if (related.some((workspace) => workspace.state === "connecting")) return "connecting";
    if (related.some((workspace) => workspace.state === "error")) return "error";
    return related.length ? "disconnected" : "unknown";
  }

  function duplicateLabel(workspace: Workspace) {
    const connection = connections.find((item) => item.id === workspace.connectionId);
    if (!connection) return "Unknown";
    const siblings = workspaces.filter((item) => item.connectionId === workspace.connectionId);
    const position = siblings.findIndex((item) => item.id === workspace.id);
    return position > 0 ? `${connection.displayName} ${position + 1}` : connection.displayName;
  }

  function pasteIntoTerminal(command: string) {
    if (!activeWorkspace?.sessionId) return;
    void api.writeSession(activeWorkspace.sessionId, new TextEncoder().encode(command));
    updateWorkspace(activeWorkspace.id, { view: "terminal" });
  }

  if (loading) return <LoadingState label="Starting Control Room…" />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <label className="search-field sidebar-search">
          <Search size={14} />
          <input
            ref={hostSearchRef}
            value={hostSearch}
            onChange={(event) => setHostSearch(event.target.value)}
            placeholder="Find a connection"
          />
          <kbd>Ctrl K</kbd>
        </label>
        <div className="sidebar-heading">
          <span>Connections</span>
        </div>
        <nav className="host-list" aria-label="Saved connections">
          {filteredConnections.map((connection) => (
            <div className="host-row" key={connection.id}>
              <button
                className="host-main"
                type="button"
                onClick={() => openConnection(connection)}
              >
                <StatusDot state={aggregateState(connection.id)} />
                <span>
                  <strong>{connection.displayName}</strong>
                  <small>{connectionTarget(connection)}</small>
                </span>
              </button>
              <button
                className="host-menu"
                type="button"
                onClick={() => setDialogConnection(connection)}
                aria-label={`Edit ${connection.displayName}`}
              >
                <MoreHorizontal size={16} />
              </button>
              <button
                className="new-session-button"
                type="button"
                onClick={() => openConnection(connection, true)}
                aria-label={`Open another ${connection.displayName} session`}
              >
                <Plus size={15} />
              </button>
            </div>
          ))}
          {!filteredConnections.length && (
            <p className="sidebar-empty">
              {connections.length ? "No matches" : "No connections yet"}
            </p>
          )}
        </nav>
        <div className="sidebar-footer">
          <button
            className={settingsOpen ? "sidebar-action active" : "sidebar-action"}
            type="button"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={16} /> Settings
          </button>
          <button
            className="sidebar-action"
            type="button"
            onClick={() => setDialogConnection("new")}
          >
            <Plus size={16} /> Add connection
          </button>
        </div>
      </aside>

      <main className="workspace-shell">
        {workspaces.length > 0 && (
          <nav className="session-tabs" aria-label="Open Workspaces">
            {workspaces.map((workspace) => (
              <button
                className={
                  workspace.id === activeWorkspaceId && !settingsOpen
                    ? "session-tab active"
                    : "session-tab"
                }
                type="button"
                key={workspace.id}
                onClick={() => {
                  setActiveWorkspaceId(workspace.id);
                  setSettingsOpen(false);
                }}
              >
                <StatusDot state={workspace.state} />
                <span>{duplicateLabel(workspace)}</span>
                <X
                  size={14}
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeWorkspace(workspace.id);
                  }}
                />
              </button>
            ))}
          </nav>
        )}

        {settingsOpen ? (
          <SettingsPane settings={settings} environment={environment} onSaved={setSettings} />
        ) : activeWorkspace && activeConnection ? (
          <>
            <header className="host-header">
              <div>
                <span className="host-title-line">
                  <h1>{activeConnection.displayName}</h1>
                  <StatusDot state={activeWorkspace.state} />
                  <small>{activeWorkspace.state}</small>
                </span>
                <p className="technical">{connectionTarget(activeConnection)}</p>
              </div>
              <div className="host-header-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setDialogConnection(activeConnection)}
                >
                  Edit
                </button>
                <button
                  className="danger-button"
                  type="button"
                  onClick={() => deleteConnection(activeConnection)}
                >
                  Delete
                </button>
              </div>
            </header>
            <nav className="feature-nav" aria-label="Workspace features">
              {navigation.map(({ id, label, icon: Icon }) => (
                <button
                  className={activeWorkspace.view === id ? "active" : ""}
                  type="button"
                  key={id}
                  onClick={() => updateWorkspace(activeWorkspace.id, { view: id })}
                >
                  <Icon size={15} /> {label}
                </button>
              ))}
            </nav>
            <div className="workspace-content">
              {workspaces.map((workspace) => {
                const connection = connections.find((item) => item.id === workspace.connectionId);
                if (!connection) return null;
                return (
                  <TerminalPane
                    key={workspace.id}
                    connection={connection}
                    workspace={workspace}
                    settings={settings}
                    visible={
                      workspace.id === activeWorkspace.id && activeWorkspace.view === "terminal"
                    }
                    onSession={(sessionId) => updateWorkspace(workspace.id, { sessionId })}
                    onState={(state, reason) => updateWorkspace(workspace.id, { state, reason })}
                  />
                );
              })}
              {activeWorkspace.view === "overview" && (
                <OverviewPane connection={activeConnection} />
              )}
              {activeWorkspace.view === "services" && (
                <ServicesPane
                  connection={activeConnection}
                  onViewLogs={() => updateWorkspace(activeWorkspace.id, { view: "logs" })}
                />
              )}
              {activeWorkspace.view === "docker" && (
                <DockerPane
                  connection={activeConnection}
                  onViewLogs={() => updateWorkspace(activeWorkspace.id, { view: "logs" })}
                />
              )}
              {activeWorkspace.view === "logs" && (
                <LogsPane connection={activeConnection} settings={settings} />
              )}
              {activeWorkspace.view === "history" && (
                <HistoryPane
                  connection={activeConnection}
                  paused={activeWorkspace.historyPaused}
                  onPausedChange={(historyPaused) =>
                    updateWorkspace(activeWorkspace.id, { historyPaused })
                  }
                  onConnectionChanged={saveConnection}
                  onPaste={pasteIntoTerminal}
                />
              )}
            </div>
          </>
        ) : bootError ? (
          <ErrorState message={bootError} />
        ) : (
          <section className="empty-workspace">
            <h1>{connections.length ? "Select a connection" : "No connections yet"}</h1>
            <p>
              {connections.length
                ? "Choose a saved connection from the sidebar to open it."
                : "Use Add connection in the sidebar to save an SSH destination."}
            </p>
            {!environment.sshPath && (
              <p className="inline-warning">
                Windows OpenSSH was not detected. Install the OpenSSH Client optional feature first.
              </p>
            )}
          </section>
        )}
      </main>

      {dialogConnection && (
        <ConnectionDialog
          connection={dialogConnection === "new" ? undefined : dialogConnection}
          onClose={() => setDialogConnection(null)}
          onSaved={saveConnection}
        />
      )}
    </div>
  );
}
