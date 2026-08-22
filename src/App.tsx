import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
  FileClock,
  Gauge,
  History,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Server,
  Settings,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { ErrorState, LoadingState } from "./components/PanelState";
import { StatusDot } from "./components/StatusDot";
import { WindowControls } from "./components/WindowControls";
import { api, errorMessage } from "./lib/api";
import { connectionTarget } from "./lib/format";
import { emptyCachedList } from "./lib/workspace-cache";
import { DockerPane } from "./pages/DockerPane";
import { HistoryPane } from "./pages/HistoryPane";
import { LogsPane } from "./pages/LogsPane";
import { OverviewPane } from "./pages/OverviewPane";
import { ServicesPane } from "./pages/ServicesPane";
import { SettingsPane } from "./pages/SettingsPane";
import type {
  AppSettings,
  CachedList,
  ConnectionState,
  DockerContainer,
  EnvironmentInfo,
  LogSourceSelection,
  SavedConnection,
  SystemdService,
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

const TerminalPane = lazy(() =>
  import("./components/TerminalPane").then((module) => ({ default: module.TerminalPane })),
);

export function App() {
  const [connections, setConnections] = useState<SavedConnection[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [settings, setSettings] = useState(defaultSettings);
  const [environment, setEnvironment] = useState(emptyEnvironment);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hostSearch, setHostSearch] = useState("");
  const [hostMenuConnectionId, setHostMenuConnectionId] = useState<string | null>(null);
  const [dialogConnection, setDialogConnection] = useState<SavedConnection | "new" | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const hostSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let current = true;
    void Promise.allSettled([api.listConnections(), api.settings(), api.environment()])
      .then(([connectionsResult, settingsResult, environmentResult]) => {
        if (!current) return;
        if (connectionsResult.status === "fulfilled") {
          setConnections(connectionsResult.value);
        } else {
          setBootError(errorMessage(connectionsResult.reason));
        }
        if (settingsResult.status === "fulfilled") setSettings(settingsResult.value);
        if (environmentResult.status === "fulfilled") setEnvironment(environmentResult.value);
      })
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, []);

  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const activeConnection = activeWorkspace?.connectionSnapshot ?? null;
  const activeSavedConnection = activeWorkspace
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
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.key.toLowerCase() === "n" &&
        activeSavedConnection
      ) {
        event.preventDefault();
        openConnection(activeSavedConnection, true);
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
  }, [activeSavedConnection, activeWorkspace]);

  useEffect(() => {
    if (!hostMenuConnectionId) return;

    function dismissMenu(event: PointerEvent) {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(`[data-host-menu="${hostMenuConnectionId}"]`)
      ) {
        return;
      }
      setHostMenuConnectionId(null);
    }

    function dismissMenuWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") setHostMenuConnectionId(null);
    }

    document.addEventListener("pointerdown", dismissMenu);
    document.addEventListener("keydown", dismissMenuWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismissMenu);
      document.removeEventListener("keydown", dismissMenuWithKeyboard);
    };
  }, [hostMenuConnectionId]);

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

  function updateServicesCache(id: string, servicesCache: CachedList<SystemdService>) {
    updateWorkspace(id, { servicesCache });
  }

  function updateContainersCache(id: string, containersCache: CachedList<DockerContainer>) {
    updateWorkspace(id, { containersCache });
  }

  function openLogs(id: string, logSource: LogSourceSelection) {
    updateWorkspace(id, { view: "logs", logSource });
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
      connectionSnapshot: { ...connection },
      sessionId: null,
      state: "connecting",
      reason: null,
      view: "terminal",
      historyPaused: false,
      reconnectToken: 0,
      servicesCache: emptyCachedList(),
      containersCache: emptyCachedList(),
      logSource: null,
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
    const siblings = workspaces.filter((item) => item.connectionId === workspace.connectionId);
    const position = siblings.findIndex((item) => item.id === workspace.id);
    return position > 0
      ? `${workspace.connectionSnapshot.displayName} ${position + 1}`
      : workspace.connectionSnapshot.displayName;
  }

  function pasteIntoTerminal(command: string) {
    if (!activeWorkspace?.sessionId) return;
    void api.writeSession(activeWorkspace.sessionId, new TextEncoder().encode(command));
    updateWorkspace(activeWorkspace.id, { view: "terminal" });
  }

  if (loading) return <LoadingState label="Starting Control Room…" />;

  return (
    <div className="app-shell">
      <header className="app-bar" data-tauri-drag-region>
        <label className="search-field app-search">
          <Search size={16} />
          <input
            ref={hostSearchRef}
            value={hostSearch}
            onChange={(event) => setHostSearch(event.target.value)}
            placeholder="Search connections"
          />
          <kbd>Ctrl+K</kbd>
        </label>
        <div className="app-bar-actions">
          <button
            className={settingsOpen ? "app-bar-button active" : "app-bar-button"}
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open Settings"
            title="Settings"
          >
            <Settings size={18} />
          </button>
          <span className="window-controls-divider" aria-hidden="true" />
          <WindowControls />
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-heading sidebar-top-heading" data-tauri-drag-region>
          <span>Connections</span>
          <span>{connections.length}</span>
        </div>
        <nav className="host-list" aria-label="Saved connections">
          {filteredConnections.map((connection) => (
            <div
              className={[
                "host-row",
                activeWorkspace?.connectionId === connection.id && !settingsOpen ? "active" : "",
                hostMenuConnectionId === connection.id ? "menu-open" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-host-menu={connection.id}
              key={connection.id}
            >
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
                onClick={() =>
                  setHostMenuConnectionId((current) =>
                    current === connection.id ? null : connection.id,
                  )
                }
                aria-label={`Open actions for ${connection.displayName}`}
                aria-haspopup="menu"
                aria-expanded={hostMenuConnectionId === connection.id}
              >
                <MoreHorizontal size={16} />
              </button>
              {hostMenuConnectionId === connection.id && (
                <div className="host-context-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setHostMenuConnectionId(null);
                      setDialogConnection(connection);
                    }}
                  >
                    <Pencil size={14} /> Edit connection
                  </button>
                  <button
                    className="danger-text"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setHostMenuConnectionId(null);
                      void deleteConnection(connection);
                    }}
                  >
                    <Trash2 size={14} /> Delete connection
                  </button>
                </div>
              )}
            </div>
          ))}
          {!filteredConnections.length && (
            <p className="sidebar-empty">
              {connections.length ? "No matches" : "No connections yet"}
            </p>
          )}
        </nav>
        {activeWorkspace && activeConnection && (
          <div className="workspace-navigation">
            <div className="sidebar-heading workspace-navigation-heading">
              <span>{activeConnection.displayName}</span>
              <StatusDot state={activeWorkspace.state} />
            </div>
            <nav className="feature-nav" aria-label="Workspace features">
              {navigation.map(({ id, label, icon: Icon }) => (
                <button
                  className={activeWorkspace.view === id && !settingsOpen ? "active" : ""}
                  type="button"
                  key={id}
                  aria-current={activeWorkspace.view === id && !settingsOpen ? "page" : undefined}
                  onClick={() => {
                    setSettingsOpen(false);
                    updateWorkspace(activeWorkspace.id, { view: id });
                  }}
                >
                  <Icon size={17} strokeWidth={1.8} /> {label}
                </button>
              ))}
            </nav>
          </div>
        )}
        <div className="sidebar-footer">
          <button
            className="sidebar-primary"
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
              <div
                className={
                  workspace.id === activeWorkspaceId && !settingsOpen
                    ? "session-tab-wrap active"
                    : "session-tab-wrap"
                }
                key={workspace.id}
              >
                <button
                  className="session-tab-main"
                  type="button"
                  aria-current={
                    workspace.id === activeWorkspaceId && !settingsOpen ? "page" : undefined
                  }
                  onClick={() => {
                    setActiveWorkspaceId(workspace.id);
                    setSettingsOpen(false);
                  }}
                >
                  <StatusDot state={workspace.state} />
                  <span>{duplicateLabel(workspace)}</span>
                </button>
                <button
                  className="session-tab-close"
                  type="button"
                  onClick={() => void closeWorkspace(workspace.id)}
                  aria-label={`Close ${duplicateLabel(workspace)} Workspace`}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <button
              className="session-new-terminal"
              type="button"
              onClick={() => activeSavedConnection && openConnection(activeSavedConnection, true)}
              disabled={!activeSavedConnection}
              title="Open another terminal in this window (Ctrl+Shift+N)"
            >
              <Plus size={15} /> New terminal
            </button>
          </nav>
        )}

        {activeWorkspace && activeConnection && activeSavedConnection && (
          <section
            className={settingsOpen ? "workspace-view workspace-view-hidden" : "workspace-view"}
            aria-hidden={settingsOpen || undefined}
          >
            <header className="host-header">
              <div>
                <span className="host-title-line">
                  <h1>{activeConnection.displayName}</h1>
                  <StatusDot state={activeWorkspace.state} />
                  <small>{activeWorkspace.state}</small>
                </span>
                <p className="technical">{connectionTarget(activeConnection)}</p>
              </div>
            </header>
            <div className="workspace-content">
              <Suspense fallback={<LoadingState label="Opening terminal…" />}>
                {workspaces.map((workspace) => (
                  <TerminalPane
                    key={workspace.id}
                    connection={workspace.connectionSnapshot}
                    workspace={workspace}
                    settings={settings}
                    visible={
                      !settingsOpen &&
                      workspace.id === activeWorkspace.id &&
                      activeWorkspace.view === "terminal"
                    }
                    onSession={(sessionId) => updateWorkspace(workspace.id, { sessionId })}
                    onState={(state, reason) => updateWorkspace(workspace.id, { state, reason })}
                  />
                ))}
              </Suspense>
              {activeWorkspace.view === "overview" && (
                <OverviewPane connection={activeConnection} />
              )}
              {activeWorkspace.view === "services" && (
                <ServicesPane
                  connection={activeConnection}
                  cache={activeWorkspace.servicesCache}
                  onCacheChange={(cache) => updateServicesCache(activeWorkspace.id, cache)}
                  onViewLogs={(source) => openLogs(activeWorkspace.id, source)}
                />
              )}
              {activeWorkspace.view === "docker" && (
                <DockerPane
                  connection={activeConnection}
                  cache={activeWorkspace.containersCache}
                  onCacheChange={(cache) => updateContainersCache(activeWorkspace.id, cache)}
                  onViewLogs={(source) => openLogs(activeWorkspace.id, source)}
                />
              )}
              {activeWorkspace.view === "logs" && (
                <LogsPane
                  connection={activeConnection}
                  settings={settings}
                  servicesCache={activeWorkspace.servicesCache}
                  containersCache={activeWorkspace.containersCache}
                  selectedSource={activeWorkspace.logSource}
                  onServicesCacheChange={(cache) => updateServicesCache(activeWorkspace.id, cache)}
                  onContainersCacheChange={(cache) =>
                    updateContainersCache(activeWorkspace.id, cache)
                  }
                  onSourceChange={(logSource) => updateWorkspace(activeWorkspace.id, { logSource })}
                />
              )}
              {activeWorkspace.view === "history" && (
                <HistoryPane
                  connection={activeConnection}
                  paused={activeWorkspace.historyPaused}
                  globalEnabled={settings.globalHistoryEnabled}
                  onPausedChange={(historyPaused) =>
                    updateWorkspace(activeWorkspace.id, { historyPaused })
                  }
                  onConnectionChanged={(saved) => {
                    saveConnection(saved);
                    updateWorkspace(activeWorkspace.id, {
                      connectionSnapshot: {
                        ...activeWorkspace.connectionSnapshot,
                        historyEnabled: saved.historyEnabled,
                        updatedAt: saved.updatedAt,
                      },
                    });
                  }}
                  onPaste={pasteIntoTerminal}
                />
              )}
            </div>
          </section>
        )}

        {settingsOpen ? (
          <SettingsPane settings={settings} environment={environment} onSaved={setSettings} />
        ) : activeWorkspace && activeConnection && activeSavedConnection ? null : bootError ? (
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

      <footer className="status-rail">
        <span className="status-rail-item">
          <StatusDot state={activeWorkspace?.state ?? "unknown"} />
          {activeWorkspace ? duplicateLabel(activeWorkspace) : "No active Workspace"}
        </span>
        <span className="status-rail-item status-rail-target">
          {activeConnection ? connectionTarget(activeConnection) : "Windows OpenSSH"}
        </span>
        <span className="status-rail-item">
          {settingsOpen
            ? "Settings"
            : activeWorkspace
              ? navigation.find(({ id }) => id === activeWorkspace.view)?.label
              : "Ready"}
        </span>
      </footer>

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
