import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
  Camera,
  ChevronDown,
  ChevronRight,
  Columns2,
  FileClock,
  FolderCog,
  Gauge,
  History,
  Maximize2,
  MoreHorizontal,
  Minimize2,
  Network,
  Pencil,
  Power,
  Plus,
  Rows2,
  Search,
  Server,
  Settings,
  SquareTerminal,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import { CommandPalette } from "./components/CommandPalette";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { ConnectionGroupsDialog } from "./components/ConnectionGroupsDialog";
import { ErrorState, LoadingState } from "./components/PanelState";
import { PromptDialog } from "./components/PromptDialog";
import { HostOsIcon } from "./components/HostOsIcon";
import { WindowControls } from "./components/WindowControls";
import { useWorkspacePersistence } from "./hooks/use-workspace-persistence";
import { api, errorMessage } from "./lib/api";
import { organizeConnections } from "./lib/connection-organization";
import { tagBadgeStyle } from "./lib/connection-tag-color";
import { connectionTarget } from "./lib/format";
import { detectHostCapabilities } from "./lib/host-capabilities";
import { isWorkspaceShortcutBlocked } from "./lib/terminal-flow";
import { clearScratchpadDraft, quiesceScratchpad, resumeScratchpad } from "./lib/scratchpad-draft";
import {
  createTerminalLayout,
  getTerminalLayoutIds,
  getTerminalPaneRects,
  removeTerminalFromLayout,
  selectTerminalTab,
  splitTerminalLayout,
  terminalLayoutContains,
} from "./lib/terminal-layout";
import type { TerminalLayout, TerminalSplitDirection } from "./lib/terminal-layout";
import { restoreWorkspaceState } from "./lib/workspace-persistence";
import {
  removeConnectionWorkspaces,
  updateWorkspaceConnectionSnapshots,
  workspaceDisplayLabel,
} from "./lib/workspace-lifecycle";
import {
  createLocalWorkspace,
  createRemoteWorkspace,
  isLocalWorkspace,
  isRemoteWorkspace,
  workspaceTargetName,
} from "./lib/workspace-target";
import { DockerPane } from "./pages/DockerPane";
import { BootDiagnosticsPane } from "./pages/BootDiagnosticsPane";
import { HistoryPane } from "./pages/HistoryPane";
import { LogsPane } from "./pages/LogsPane";
import { OverviewPane } from "./pages/OverviewPane";
import { PortsPane } from "./pages/PortsPane";
import { ServicesPane } from "./pages/ServicesPane";
import { ScratchpadPane } from "./pages/ScratchpadPane";
import { SettingsPane } from "./pages/SettingsPane";
import { BaselinesPane } from "./pages/BaselinesPane";
import type {
  CachedList,
  BootDiagnostics,
  ConnectionGroup,
  ConnectionState,
  ConnectionTag,
  DockerContainer,
  DockerContainerDetails,
  EnvironmentInfo,
  HostCapabilities,
  ListeningSocket,
  LocalShellProfile,
  LogSourceSelection,
  RemoteWorkspace,
  SavedConnection,
  SettingsContract,
  SystemdUnit,
  CachedValue,
  Workspace,
  WorkspacePatch,
  WorkspaceView,
} from "./types";

const emptyEnvironment: EnvironmentInfo = {
  sshPath: null,
  sshConfigPath: "%USERPROFILE%\\.ssh\\config",
  sshAgentAvailable: false,
  platformSupported: true,
};

const navigation: { id: WorkspaceView; label: string; icon: typeof Gauge }[] = [
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "services", label: "Systemd", icon: Server },
  { id: "ports", label: "Ports", icon: Network },
  { id: "docker", label: "Docker", icon: Boxes },
  { id: "boot", label: "Boot", icon: Power },
  { id: "logs", label: "Logs", icon: FileClock },
  { id: "baselines", label: "Baselines", icon: Camera },
  { id: "history", label: "History", icon: History },
  { id: "scratchpad", label: "Scratchpad", icon: StickyNote },
];

const TerminalPane = lazy(() =>
  import("./components/TerminalPane").then((module) => ({ default: module.TerminalPane })),
);

export function App() {
  const [connections, setConnections] = useState<SavedConnection[]>([]);
  const [localShells, setLocalShells] = useState<LocalShellProfile[]>([]);
  const [localShellMenuOpen, setLocalShellMenuOpen] = useState(false);
  const [connectionGroups, setConnectionGroups] = useState<ConnectionGroup[]>([]);
  const [knownTags, setKnownTags] = useState<ConnectionTag[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [settingsContract, setSettingsContract] = useState<SettingsContract | null>(null);
  const [environment, setEnvironment] = useState(emptyEnvironment);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [hostSearch, setHostSearch] = useState("");
  const [ungroupedCollapsed, setUngroupedCollapsed] = useState(false);
  const [connectionGroupsOpen, setConnectionGroupsOpen] = useState(false);
  const [hostCapabilities, setHostCapabilities] = useState<Record<string, HostCapabilities>>({});
  const [hostMenuConnectionId, setHostMenuConnectionId] = useState<string | null>(null);
  const [dialogConnection, setDialogConnection] = useState<SavedConnection | "new" | null>(null);
  const [terminalFocusMode, setTerminalFocusMode] = useState(false);
  const [terminalLayout, setTerminalLayout] = useState<TerminalLayout | null>(null);
  const [splitDirection, setSplitDirection] = useState<TerminalSplitDirection>("vertical");
  const [splitMenuOpen, setSplitMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Workspace | null>(null);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [workspacePersistenceReady, setWorkspacePersistenceReady] = useState(false);
  const capabilityDetectionsRef = useRef(new Set<string>());
  useEffect(() => {
    let current = true;
    void Promise.allSettled([
      api.listConnections(),
      api.settingsContract(),
      api.environment(),
      api.workspaceState(),
      api.listConnectionGroups(),
      api.listConnectionTags(),
      api.listLocalShells(),
    ])
      .then(
        ([
          connectionsResult,
          settingsResult,
          environmentResult,
          workspaceStateResult,
          groupsResult,
          tagsResult,
          localShellsResult,
        ]) => {
          if (!current) return;
          const detectedShells =
            localShellsResult.status === "fulfilled" ? localShellsResult.value : [];
          setLocalShells(detectedShells);
          if (connectionsResult.status === "fulfilled") {
            setConnections(connectionsResult.value);
            if (workspaceStateResult.status === "fulfilled") {
              const restored = restoreWorkspaceState(
                connectionsResult.value,
                workspaceStateResult.value,
                detectedShells,
              );
              setWorkspaces(restored.workspaces);
              setActiveWorkspaceId(restored.activeWorkspaceId);
              setTerminalLayout(restored.terminalLayout);
              setWorkspacePersistenceReady(true);
            } else {
              setActionError(
                `Could not restore Workspaces: ${errorMessage(workspaceStateResult.reason)}`,
              );
            }
            for (const connection of connectionsResult.value) {
              void api
                .cachedCapabilities(connection.id)
                .then((capabilities) => {
                  if (current && capabilities) rememberCapabilities(capabilities);
                })
                .catch(() => undefined);
            }
          } else {
            setBootError(errorMessage(connectionsResult.reason));
          }
          if (settingsResult.status === "fulfilled") {
            setSettingsContract(settingsResult.value);
          } else {
            setBootError(`Could not load Settings: ${errorMessage(settingsResult.reason)}`);
          }
          if (environmentResult.status === "fulfilled") setEnvironment(environmentResult.value);
          if (groupsResult.status === "fulfilled") setConnectionGroups(groupsResult.value);
          else
            setActionError(
              `Could not load connection groups: ${errorMessage(groupsResult.reason)}`,
            );
          if (tagsResult.status === "fulfilled") setKnownTags(tagsResult.value);
          else setActionError(`Could not load connection tags: ${errorMessage(tagsResult.reason)}`);
        },
      )
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, []);

  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  // Inspection views, Enhanced History, and Saved Connection actions belong to
  // a remote Workspace. A local one is terminal-only.
  const activeRemoteWorkspace =
    activeWorkspace && isRemoteWorkspace(activeWorkspace) ? activeWorkspace : null;
  const activeConnection = activeRemoteWorkspace?.connectionSnapshot ?? null;
  const activeSavedConnection = activeRemoteWorkspace
    ? (connections.find((connection) => connection.id === activeRemoteWorkspace.connectionId) ??
      null)
    : null;
  // "New terminal" repeats whatever the active Workspace already is: another
  // session on its Saved Connection, or another shell of the same profile.
  const canOpenNewTerminal = Boolean(
    activeWorkspace && (isLocalWorkspace(activeWorkspace) || activeSavedConnection),
  );
  const focusedTerminalIds = terminalLayout ? getTerminalLayoutIds(terminalLayout) : [];
  const visibleTerminalIds = terminalFocusMode
    ? focusedTerminalIds
    : activeWorkspace
      ? [activeWorkspace.id]
      : [];
  const terminalSplitMode = terminalFocusMode && focusedTerminalIds.length > 1;
  const terminalPaneRects = terminalLayout ? getTerminalPaneRects(terminalLayout) : {};
  const existingSplitCandidates = workspaces.filter(
    (workspace) => !focusedTerminalIds.includes(workspace.id),
  );
  useWorkspacePersistence({
    ready: workspacePersistenceReady,
    workspaces,
    activeWorkspaceId,
    terminalLayout,
    onError: setActionError,
  });

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (
        isWorkspaceShortcutBlocked(
          event.target,
          settingsOpen || dialogConnection !== null || hostMenuConnectionId !== null,
        )
      ) {
        return;
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
          connectRequested: true,
          reconnectToken: activeWorkspace.reconnectToken + 1,
        });
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [activeWorkspace, dialogConnection, hostMenuConnectionId, settingsOpen]);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "p" && !event.repeat) {
        if (paletteOpen) {
          event.preventDefault();
          setPaletteOpen(false);
          return;
        }
        // Do not stack the palette on top of a modal dialog (connection or sudo).
        if (dialogConnection !== null || document.querySelector('[role="dialog"]')) return;
        event.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [paletteOpen, dialogConnection]);

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

  useEffect(() => {
    if (!localShellMenuOpen) return;

    function dismissMenu(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-local-shell-menu]")) return;
      setLocalShellMenuOpen(false);
    }

    function dismissMenuWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") setLocalShellMenuOpen(false);
    }

    document.addEventListener("pointerdown", dismissMenu);
    document.addEventListener("keydown", dismissMenuWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismissMenu);
      document.removeEventListener("keydown", dismissMenuWithKeyboard);
    };
  }, [localShellMenuOpen]);

  useEffect(() => {
    if (!splitMenuOpen) return;

    function dismissMenu(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-terminal-split-menu]")) return;
      setSplitMenuOpen(false);
    }

    function dismissMenuWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") setSplitMenuOpen(false);
    }

    document.addEventListener("pointerdown", dismissMenu);
    document.addEventListener("keydown", dismissMenuWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismissMenu);
      document.removeEventListener("keydown", dismissMenuWithKeyboard);
    };
  }, [splitMenuOpen]);

  const connectionSections = useMemo(
    () => organizeConnections(connections, connectionGroups, hostSearch, ungroupedCollapsed),
    [connections, connectionGroups, hostSearch, ungroupedCollapsed],
  );

  // The most meaningful live session state per saved connection, used to mark
  // which connections currently have an open Workspace and how it is doing.
  const connectionSessionStates = useMemo(() => {
    const priority: ConnectionState[] = ["connected", "connecting", "error", "disconnected"];
    const map: Record<string, ConnectionState> = {};
    for (const workspace of workspaces) {
      if (!isRemoteWorkspace(workspace)) continue;
      const current = map[workspace.connectionId];
      if (!current || priority.indexOf(workspace.state) < priority.indexOf(current)) {
        map[workspace.connectionId] = workspace.state;
      }
    }
    return map;
  }, [workspaces]);

  function updateWorkspace(id: string, patch: WorkspacePatch) {
    setWorkspaces((current) =>
      current.map((workspace) => (workspace.id === id ? { ...workspace, ...patch } : workspace)),
    );
  }

  /// Patches the fields only a remote Workspace has: inspection caches,
  /// selections, and Enhanced History state. A local Workspace is left alone
  /// rather than given fields it has no use for.
  function updateRemoteWorkspace(id: string, patch: Partial<Omit<RemoteWorkspace, "kind">>) {
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === id && isRemoteWorkspace(workspace)
          ? { ...workspace, ...patch }
          : workspace,
      ),
    );
  }

  // Closes Settings and then runs `after`. When there are unsaved changes it
  // asks for confirmation first and defers `after` until the user discards, so
  // callers pass the navigation they intend instead of a synchronous guard.
  function closeSettings(after: () => void = () => {}): boolean {
    if (settingsOpen && settingsDirty) {
      setConfirmState({
        title: "Discard changes?",
        message: "Discard unsaved Settings changes?",
        confirmLabel: "Discard",
        danger: true,
        onConfirm: () => {
          setSettingsDirty(false);
          setSettingsOpen(false);
          after();
        },
      });
      return false;
    }
    setSettingsDirty(false);
    setSettingsOpen(false);
    after();
    return true;
  }

  function enterTerminalFocus() {
    if (!activeWorkspace || settingsOpen || activeWorkspace.view !== "terminal") return;
    setTerminalLayout((current) =>
      current && terminalLayoutContains(current, activeWorkspace.id)
        ? current
        : createTerminalLayout(activeWorkspace.id),
    );
    setSplitMenuOpen(false);
    setTerminalFocusMode(true);
  }

  function exitTerminalFocus() {
    setSplitMenuOpen(false);
    setTerminalFocusMode(false);
  }

  function selectWorkspaceTab(workspace: Workspace) {
    closeSettings(() => {
      setActiveWorkspaceId(workspace.id);
      if (!terminalFocusMode) return;
      updateWorkspace(workspace.id, { view: "terminal" });
      setTerminalLayout((current) =>
        current ? selectTerminalTab(current, workspace.id) : createTerminalLayout(workspace.id),
      );
    });
  }

  function splitWithExistingTerminal(workspace: Workspace) {
    if (!activeWorkspace) return;
    updateWorkspace(workspace.id, { view: "terminal" });
    setTerminalLayout((current) =>
      splitTerminalLayout(
        current && terminalLayoutContains(current, activeWorkspace.id)
          ? current
          : createTerminalLayout(activeWorkspace.id),
        activeWorkspace.id,
        workspace.id,
        splitDirection,
      ),
    );
    setActiveWorkspaceId(workspace.id);
    setSplitMenuOpen(false);
  }

  function removeTerminalFromSplit(workspaceId: string) {
    if (!terminalLayout) return;
    const nextLayout = removeTerminalFromLayout(terminalLayout, workspaceId);
    if (!nextLayout) return;
    const remaining = getTerminalLayoutIds(nextLayout);
    setTerminalLayout(nextLayout);
    if (activeWorkspaceId === workspaceId) {
      setActiveWorkspaceId(remaining[0]);
      updateWorkspace(remaining[0], { view: "terminal" });
    }
  }

  function updateServicesCache(id: string, servicesCache: CachedList<SystemdUnit>) {
    updateRemoteWorkspace(id, { servicesCache });
  }

  function updateContainersCache(id: string, containersCache: CachedList<DockerContainer>) {
    updateRemoteWorkspace(id, { containersCache });
  }

  function updatePortsCache(id: string, portsCache: CachedList<ListeningSocket>) {
    updateRemoteWorkspace(id, { portsCache });
  }

  function updateContainerDetailsCache(
    id: string,
    containerId: string,
    details: CachedValue<DockerContainerDetails>,
  ) {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace || !isRemoteWorkspace(workspace)) return;
    updateRemoteWorkspace(id, {
      containerDetailsCache: {
        ...workspace.containerDetailsCache,
        [containerId]: details,
      },
    });
  }

  function updateBootDiagnostics(id: string, bootDiagnostics: BootDiagnostics) {
    updateRemoteWorkspace(id, { bootDiagnostics });
  }

  function rememberCapabilities(capabilities: HostCapabilities) {
    setHostCapabilities((current) => ({
      ...current,
      [capabilities.connectionId]: capabilities,
    }));
  }

  function detectConnectionCapabilities(connectionId: string) {
    if (capabilityDetectionsRef.current.has(connectionId)) return;
    capabilityDetectionsRef.current.add(connectionId);
    void detectHostCapabilities(api, connectionId)
      .then(rememberCapabilities)
      .catch(() => undefined)
      .finally(() => capabilityDetectionsRef.current.delete(connectionId));
  }

  function openLogs(id: string, logSource: LogSourceSelection) {
    updateRemoteWorkspace(id, { view: "logs", logSource });
  }

  function splitWithNewWorkspace(workspace: Workspace) {
    if (!activeWorkspace) return;
    setWorkspaces((current) => [...current, workspace]);
    setTerminalLayout((current) =>
      splitTerminalLayout(
        current && terminalLayoutContains(current, activeWorkspace.id)
          ? current
          : createTerminalLayout(activeWorkspace.id),
        activeWorkspace.id,
        workspace.id,
        splitDirection,
      ),
    );
    setActiveWorkspaceId(workspace.id);
    setSplitMenuOpen(false);
  }

  function openConnection(connection: SavedConnection, forceNew = false) {
    closeSettings(() => {
      if (!forceNew) {
        const existing = [...workspaces]
          .reverse()
          .find(
            (workspace) => isRemoteWorkspace(workspace) && workspace.connectionId === connection.id,
          );
        if (existing) {
          setActiveWorkspaceId(existing.id);
          return;
        }
      }
      openWorkspace(createRemoteWorkspace(connection));
    });
  }

  /// Opens a local Windows shell as its own Workspace. Each launch is a new
  /// shell, so there is nothing to reuse, and no Saved Connection is involved.
  function openLocalShell(shell: LocalShellProfile) {
    setLocalShellMenuOpen(false);
    closeSettings(() => openWorkspace(createLocalWorkspace(shell)));
  }

  function openWorkspace(workspace: Workspace) {
    setWorkspaces((current) => [...current, workspace]);
    setActiveWorkspaceId(workspace.id);
    if (terminalFocusMode) setTerminalLayout(createTerminalLayout(workspace.id));
  }

  /// Another terminal of whatever the active Workspace already is.
  function openAnotherTerminal() {
    if (!activeWorkspace) return;
    if (isLocalWorkspace(activeWorkspace)) {
      openLocalShell(activeWorkspace.shell);
      return;
    }
    if (activeSavedConnection) openConnection(activeSavedConnection, true);
  }

  function closeWorkspace(id: string) {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) return;
    if (workspace.sessionId) {
      const local = isLocalWorkspace(workspace);
      setConfirmState({
        title: "Close workspace",
        message: local
          ? "Stop the local shell and close this Workspace?"
          : "Disconnect the active SSH session and close this Workspace?",
        confirmLabel: local ? "Stop & close" : "Disconnect & close",
        danger: true,
        onConfirm: () => void performCloseWorkspace(id),
      });
      return;
    }
    void performCloseWorkspace(id);
  }

  async function performCloseWorkspace(id: string) {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) return;
    setActionError(null);
    if (workspace.sessionId) await api.closeSession(workspace.sessionId).catch(() => undefined);
    const index = workspaces.findIndex((item) => item.id === id);
    const remaining = workspaces.filter((item) => item.id !== id);
    const nextLayout = terminalLayout ? removeTerminalFromLayout(terminalLayout, id) : null;
    const remainingSplitIds = nextLayout ? getTerminalLayoutIds(nextLayout) : [];
    const closingActiveWorkspace = activeWorkspaceId === id;
    const nextActive = closingActiveWorkspace
      ? ((terminalFocusMode ? remaining.find((item) => item.id === remainingSplitIds[0]) : null) ??
        remaining[Math.min(index, remaining.length - 1)] ??
        null)
      : null;
    setWorkspaces(
      terminalFocusMode && nextActive
        ? remaining.map((item) =>
            item.id === nextActive.id ? { ...item, view: "terminal" } : item,
          )
        : remaining,
    );
    if (closingActiveWorkspace) {
      setActiveWorkspaceId(nextActive?.id ?? null);
    }
    setTerminalLayout(nextLayout ?? (nextActive ? createTerminalLayout(nextActive.id) : null));
    if (!remaining.length) exitTerminalFocus();
  }

  function deleteConnection(connection: SavedConnection) {
    setConfirmState({
      title: "Delete connection",
      message: `Delete the Saved Connection “${connection.displayName}” and its History? This cannot be undone.`,
      confirmLabel: "Delete connection",
      danger: true,
      onConfirm: () => void performDeleteConnection(connection),
    });
  }

  async function performDeleteConnection(connection: SavedConnection) {
    setActionError(null);
    try {
      await quiesceScratchpad("connection", connection.id);
      await api.deleteConnection(connection.id);
    } catch (caught) {
      resumeScratchpad("connection", connection.id);
      setActionError(`Could not delete Saved Connection: ${errorMessage(caught)}`);
      return;
    }
    clearScratchpadDraft("connection", connection.id);
    const removal = removeConnectionWorkspaces(
      workspaces,
      connection.id,
      activeWorkspaceId,
      terminalLayout,
    );
    for (const workspace of removal.removed) {
      if (workspace.sessionId) await api.closeSession(workspace.sessionId).catch(() => undefined);
    }
    setConnections((current) => current.filter((item) => item.id !== connection.id));
    setHostCapabilities((current) => {
      const next = { ...current };
      delete next[connection.id];
      return next;
    });
    setWorkspaces(removal.remaining);
    setTerminalLayout(removal.nextLayout);
    setActiveWorkspaceId(removal.nextActiveId);
    if (!removal.nextActiveId) exitTerminalFocus();
  }

  function saveConnection(saved: SavedConnection) {
    setConnections((current) => {
      const exists = current.some((connection) => connection.id === saved.id);
      const next = exists
        ? current.map((connection) => (connection.id === saved.id ? saved : connection))
        : [...current, saved];
      return next;
    });
    setKnownTags((current) => {
      const byId = new Map(current.map((tag) => [tag.id, tag]));
      for (const tag of saved.tags) byId.set(tag.id, tag);
      return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
    });
    setWorkspaces((current) => updateWorkspaceConnectionSnapshots(current, saved));
    setDialogConnection(null);
  }

  function handleTagUpdated(updatedTag: ConnectionTag) {
    const updateTags = (tags: ConnectionTag[]) =>
      tags.map((tag) => (tag.id === updatedTag.id ? updatedTag : tag));
    setKnownTags((current) =>
      updateTags(current).sort((left, right) => left.name.localeCompare(right.name)),
    );
    setConnections((current) =>
      current.map((connection) => ({ ...connection, tags: updateTags(connection.tags) })),
    );
    setWorkspaces((current) =>
      current.map((workspace) =>
        isRemoteWorkspace(workspace)
          ? {
              ...workspace,
              connectionSnapshot: {
                ...workspace.connectionSnapshot,
                tags: updateTags(workspace.connectionSnapshot.tags),
              },
            }
          : workspace,
      ),
    );
  }

  function handleTagDeleted(tagId: string) {
    const removeTag = (tags: ConnectionTag[]) => tags.filter((tag) => tag.id !== tagId);
    setKnownTags((current) => removeTag(current));
    setConnections((current) =>
      current.map((connection) => ({ ...connection, tags: removeTag(connection.tags) })),
    );
    setWorkspaces((current) =>
      current.map((workspace) =>
        isRemoteWorkspace(workspace)
          ? {
              ...workspace,
              connectionSnapshot: {
                ...workspace.connectionSnapshot,
                tags: removeTag(workspace.connectionSnapshot.tags),
              },
            }
          : workspace,
      ),
    );
  }

  function handleGroupDeleted(groupId: string) {
    setConnections((current) =>
      current.map((connection) =>
        connection.groupId === groupId ? { ...connection, groupId: null } : connection,
      ),
    );
    setWorkspaces((current) =>
      current.map((workspace) =>
        isRemoteWorkspace(workspace) && workspace.connectionSnapshot.groupId === groupId
          ? {
              ...workspace,
              connectionSnapshot: { ...workspace.connectionSnapshot, groupId: null },
            }
          : workspace,
      ),
    );
  }

  function toggleConnectionGroup(groupId: string | null, collapsed: boolean) {
    if (!groupId) {
      setUngroupedCollapsed(collapsed);
      return;
    }
    setConnectionGroups((current) =>
      current.map((group) => (group.id === groupId ? { ...group, collapsed } : group)),
    );
    void api.setConnectionGroupCollapsed(groupId, collapsed).catch((caught) => {
      setConnectionGroups((current) =>
        current.map((group) =>
          group.id === groupId ? { ...group, collapsed: !collapsed } : group,
        ),
      );
      setActionError(`Could not update group: ${errorMessage(caught)}`);
    });
  }

  function duplicateLabel(workspace: Workspace) {
    return workspaceDisplayLabel(workspace, workspaces);
  }

  function renameWorkspace(workspace: Workspace) {
    setRenameTarget(workspace);
  }

  function pasteIntoTerminal(command: string) {
    if (!activeRemoteWorkspace?.sessionId) {
      setActionError("Reconnect the Terminal Session before pasting a command.");
      return;
    }
    setActionError(null);
    void api
      .writeSession(activeRemoteWorkspace.sessionId, new TextEncoder().encode(command))
      .catch((caught) => setActionError(`Could not paste into terminal: ${errorMessage(caught)}`));
    updateWorkspace(activeRemoteWorkspace.id, { view: "terminal" });
  }

  /// The identity mark for a Workspace: the host OS mark for a Remote Host, a
  /// terminal mark for a local shell, since there is no operating system to
  /// report about the machine the app is already running on.
  function workspaceMark(workspace: Workspace) {
    return isLocalWorkspace(workspace) ? (
      <SquareTerminal size={17} strokeWidth={1.8} className="local-shell-mark" />
    ) : (
      <HostOsIcon osId={hostCapabilities[workspace.connectionId]?.osId} />
    );
  }

  function renderConnectionRow(connection: SavedConnection) {
    return (
      <div
        className={[
          "host-row",
          activeRemoteWorkspace?.connectionId === connection.id && !settingsOpen ? "active" : "",
          hostMenuConnectionId === connection.id ? "menu-open" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-host-menu={connection.id}
        key={connection.id}
      >
        <button className="host-main" type="button" onClick={() => openConnection(connection)}>
          <span className="os-badge">
            <HostOsIcon osId={hostCapabilities[connection.id]?.osId} />
            {connectionSessionStates[connection.id] && (
              <span
                className={`presence presence-${connectionSessionStates[connection.id]}`}
                aria-hidden="true"
              />
            )}
          </span>
          <span className="host-row-details">
            <strong>{connection.displayName}</strong>
            <small>{connectionTarget(connection)}</small>
            {!!connection.tags.length && (
              <span className="host-tag-summary">
                {connection.tags.slice(0, 2).map((tag) => (
                  <span
                    className="connection-tag-badge"
                    style={tagBadgeStyle(tag.color)}
                    key={tag.id}
                  >
                    {tag.name}
                  </span>
                ))}
                {connection.tags.length > 2 && (
                  <span className="host-tag-overflow">+{connection.tags.length - 2}</span>
                )}
              </span>
            )}
          </span>
        </button>
        <button
          className="host-menu"
          type="button"
          onClick={() =>
            setHostMenuConnectionId((current) => (current === connection.id ? null : connection.id))
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
    );
  }

  if (loading) return <LoadingState label="Starting Control Room…" />;
  if (!settingsContract) return <ErrorState message={bootError ?? "Could not load Settings."} />;
  const settings = settingsContract.current;

  return (
    <div className={terminalFocusMode ? "app-shell terminal-focus-mode" : "app-shell"}>
      <header className="app-bar" data-tauri-drag-region>
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

      {/* Only a Remote Host puts a view switcher under the list, so only it
          needs the list capped to leave room. A local Workspace has no
          switcher, so the list keeps the whole sidebar. */}
      <aside className={activeRemoteWorkspace ? "sidebar workspace-open" : "sidebar"}>
        <div className="sidebar-heading sidebar-top-heading" data-tauri-drag-region>
          <span data-tauri-drag-region>Connections</span>
          <span data-tauri-drag-region>{connections.length}</span>
        </div>
        <div className="sidebar-filter-row">
          <label className="search-field sidebar-search">
            <Search size={14} />
            <input
              value={hostSearch}
              onChange={(event) => setHostSearch(event.target.value)}
              placeholder="Name, group, tag"
              aria-label="Filter connections by name, group, or tag"
            />
          </label>
          <button
            className="icon-button"
            type="button"
            aria-label="Manage groups and tags"
            onClick={() => setConnectionGroupsOpen(true)}
            title="Manage groups and tags"
          >
            <FolderCog size={18} />
          </button>
        </div>
        <nav className="host-list" aria-label="Saved connections">
          {connectionSections.map((section) => {
            const collapsed = section.collapsed && !hostSearch.trim();
            return (
              <section className="connection-group-section" key={section.id ?? "ungrouped"}>
                <button
                  className="connection-group-heading"
                  type="button"
                  onClick={() => toggleConnectionGroup(section.id, !section.collapsed)}
                  aria-expanded={!collapsed}
                >
                  {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  <span>{section.name}</span>
                  <small>{section.connections.length}</small>
                </button>
                {!collapsed && section.connections.map(renderConnectionRow)}
              </section>
            );
          })}
          {!connectionSections.some((section) => section.connections.length) && (
            <p className="sidebar-empty">
              {connections.length ? "No matches" : "No connections yet"}
            </p>
          )}
        </nav>
        {/* The view switcher belongs to a Remote Host. A local Workspace is
            terminal-only, so it shows no inspection views at all. */}
        {activeRemoteWorkspace && (
          <div className="workspace-navigation">
            <nav className="feature-nav" aria-label="Workspace features">
              {navigation.map(({ id, label, icon: Icon }) => (
                <button
                  className={activeRemoteWorkspace.view === id && !settingsOpen ? "active" : ""}
                  type="button"
                  key={id}
                  aria-current={
                    activeRemoteWorkspace.view === id && !settingsOpen ? "page" : undefined
                  }
                  onClick={() =>
                    closeSettings(() => updateWorkspace(activeRemoteWorkspace.id, { view: id }))
                  }
                >
                  <Icon size={17} strokeWidth={1.8} /> {label}
                </button>
              ))}
            </nav>
          </div>
        )}
        <div className="sidebar-footer">
          {!!localShells.length && (
            <div className="local-shell-launcher" data-local-shell-menu>
              <button
                className="sidebar-secondary"
                type="button"
                onClick={() => setLocalShellMenuOpen((current) => !current)}
                aria-haspopup="menu"
                aria-expanded={localShellMenuOpen}
                title="Open a shell on this Windows machine"
              >
                <SquareTerminal size={16} /> Local terminal
              </button>
              {localShellMenuOpen && (
                <div className="local-shell-menu" role="menu" aria-label="Local terminal">
                  {localShells.map((shell) => (
                    <button
                      type="button"
                      role="menuitem"
                      key={shell.id}
                      onClick={() => openLocalShell(shell)}
                    >
                      <SquareTerminal size={14} strokeWidth={1.8} />
                      <span>{shell.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
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
            <div className="session-tab-list" data-tauri-drag-region>
              {workspaces.map((workspace) => (
                <div
                  className={[
                    "session-tab-wrap",
                    workspace.id === activeWorkspaceId && !settingsOpen ? "active" : "",
                    terminalFocusMode && focusedTerminalIds.includes(workspace.id)
                      ? "in-layout"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={workspace.id}
                >
                  <button
                    className="session-tab-main"
                    type="button"
                    aria-current={
                      workspace.id === activeWorkspaceId && !settingsOpen ? "page" : undefined
                    }
                    onClick={() => selectWorkspaceTab(workspace)}
                  >
                    <span className="os-badge">
                      {workspaceMark(workspace)}
                      <span className={`presence presence-${workspace.state}`} aria-hidden="true" />
                    </span>
                    <span>{duplicateLabel(workspace)}</span>
                  </button>
                  <button
                    className="session-tab-rename"
                    type="button"
                    onClick={() => renameWorkspace(workspace)}
                    aria-label={`Rename ${duplicateLabel(workspace)} Workspace`}
                    title="Rename Workspace"
                  >
                    <Pencil size={12} />
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
                onClick={openAnotherTerminal}
                disabled={!canOpenNewTerminal}
                title={
                  activeWorkspace && isLocalWorkspace(activeWorkspace)
                    ? `Open another ${activeWorkspace.shell.label} terminal`
                    : "Open another terminal in this window"
                }
              >
                <Plus size={15} /> New terminal
              </button>
            </div>
            {!settingsOpen && activeWorkspace?.view === "terminal" && (
              <div className="session-tab-actions" data-terminal-split-menu>
                {terminalFocusMode ? (
                  <>
                    <button
                      className="session-strip-button"
                      type="button"
                      onClick={() => setSplitMenuOpen((current) => !current)}
                      disabled={
                        !connections.length &&
                        !existingSplitCandidates.length &&
                        !localShells.length
                      }
                      aria-label="Split terminal"
                      aria-haspopup="dialog"
                      aria-expanded={splitMenuOpen}
                      title="Split the focused terminal pane"
                    >
                      <Columns2 size={15} />
                    </button>
                    {splitMenuOpen && (
                      <div
                        className="terminal-split-menu"
                        role="dialog"
                        aria-label="Split terminal"
                      >
                        <div className="terminal-split-directions" aria-label="Split direction">
                          <button
                            className={splitDirection === "vertical" ? "active" : ""}
                            type="button"
                            onClick={() => setSplitDirection("vertical")}
                            aria-pressed={splitDirection === "vertical"}
                          >
                            <Columns2 size={14} />
                            <span>
                              Split vertically
                              <small>Side by side</small>
                            </span>
                          </button>
                          <button
                            className={splitDirection === "horizontal" ? "active" : ""}
                            type="button"
                            onClick={() => setSplitDirection("horizontal")}
                            aria-pressed={splitDirection === "horizontal"}
                          >
                            <Rows2 size={14} />
                            <span>
                              Split horizontally
                              <small>Top and bottom</small>
                            </span>
                          </button>
                        </div>
                        {!!existingSplitCandidates.length && (
                          <>
                            <strong>Existing terminals</strong>
                            {existingSplitCandidates.map((workspace) => (
                              <button
                                type="button"
                                key={workspace.id}
                                onClick={() => splitWithExistingTerminal(workspace)}
                              >
                                {workspaceMark(workspace)}
                                <span>{duplicateLabel(workspace)}</span>
                              </button>
                            ))}
                          </>
                        )}
                        {!!localShells.length && (
                          <>
                            <strong>New local terminal</strong>
                            {localShells.map((shell) => (
                              <button
                                type="button"
                                key={shell.id}
                                onClick={() => splitWithNewWorkspace(createLocalWorkspace(shell))}
                              >
                                <SquareTerminal size={16} strokeWidth={1.8} />
                                <span>{shell.label}</span>
                              </button>
                            ))}
                          </>
                        )}
                        <strong>New from Saved Connections</strong>
                        {connections.map((connection) => (
                          <button
                            type="button"
                            key={connection.id}
                            onClick={() => splitWithNewWorkspace(createRemoteWorkspace(connection))}
                          >
                            <HostOsIcon osId={hostCapabilities[connection.id]?.osId} />
                            <span>{connection.displayName}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      className="session-strip-button"
                      type="button"
                      onClick={exitTerminalFocus}
                      aria-label="Exit terminal focus"
                      title="Exit terminal focus"
                    >
                      <Minimize2 size={15} />
                    </button>
                    <span className="window-controls-divider" aria-hidden="true" />
                    <WindowControls />
                  </>
                ) : (
                  <button
                    className="session-strip-button"
                    type="button"
                    onClick={enterTerminalFocus}
                    aria-label="Focus terminal"
                    title="Focus terminal"
                  >
                    <Maximize2 size={15} />
                  </button>
                )}
              </div>
            )}
          </nav>
        )}

        {actionError && (
          <div className="inline-error app-action-error" role="alert">
            <span>{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss error">
              <X size={14} />
            </button>
          </div>
        )}

        {activeWorkspace && (
          <section
            className={settingsOpen ? "workspace-view workspace-view-hidden" : "workspace-view"}
            aria-hidden={settingsOpen || undefined}
          >
            <div
              className={
                terminalSplitMode ? "workspace-content terminal-pane-layout" : "workspace-content"
              }
            >
              <Suspense fallback={<LoadingState label="Opening terminal…" />}>
                {workspaces.map((workspace) => {
                  const terminalVisible =
                    !settingsOpen &&
                    activeWorkspace.view === "terminal" &&
                    visibleTerminalIds.includes(workspace.id);
                  const label = duplicateLabel(workspace);
                  const paneRect = terminalPaneRects[workspace.id];
                  return (
                    <div
                      className={[
                        "terminal-workspace-pane",
                        terminalVisible ? "terminal-workspace-pane-visible" : "",
                        workspace.id === activeWorkspace.id ? "active" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      key={workspace.id}
                      aria-hidden={!terminalVisible || undefined}
                      style={
                        terminalSplitMode && terminalVisible && paneRect
                          ? {
                              left: `${paneRect.left}%`,
                              top: `${paneRect.top}%`,
                              width: `${paneRect.width}%`,
                              height: `${paneRect.height}%`,
                            }
                          : undefined
                      }
                    >
                      {terminalSplitMode && terminalVisible && (
                        <header className="terminal-pane-header">
                          <button
                            className="terminal-pane-identity"
                            type="button"
                            onClick={() => setActiveWorkspaceId(workspace.id)}
                          >
                            {workspaceMark(workspace)}
                            <span className="terminal-pane-label">{label}</span>
                          </button>
                          <button
                            className="terminal-pane-remove"
                            type="button"
                            onClick={() => removeTerminalFromSplit(workspace.id)}
                            aria-label={`Remove from split: ${label}`}
                            title="Remove from split"
                          >
                            <X size={13} />
                          </button>
                        </header>
                      )}
                      <TerminalPane
                        workspace={workspace}
                        settings={settings}
                        visible={terminalVisible}
                        active={terminalVisible && workspace.id === activeWorkspace.id}
                        onActivate={() => setActiveWorkspaceId(workspace.id)}
                        onSession={(sessionId) => updateWorkspace(workspace.id, { sessionId })}
                        onState={(state, reason) => {
                          updateWorkspace(workspace.id, {
                            state,
                            reason,
                            connectRequested:
                              state === "disconnected" || state === "error"
                                ? false
                                : workspace.connectRequested,
                          });
                          // Host capability discovery is a Remote Host read.
                          // Nothing is detected about the local machine.
                          if (state === "connected" && isRemoteWorkspace(workspace)) {
                            detectConnectionCapabilities(workspace.connectionId);
                          }
                        }}
                        onReconnect={() =>
                          updateWorkspace(workspace.id, {
                            connectRequested: true,
                            reconnectToken: workspace.reconnectToken + 1,
                          })
                        }
                      />
                    </div>
                  );
                })}
              </Suspense>
              {/* Inspection views need a Remote Host and its Saved
                  Connection. A local Workspace renders its terminal only. */}
              {activeRemoteWorkspace && activeConnection && activeSavedConnection && (
                <>
                  {activeRemoteWorkspace.view === "overview" && (
                    <OverviewPane
                      key={activeRemoteWorkspace.id}
                      connection={activeConnection}
                      onCapabilitiesChange={rememberCapabilities}
                    />
                  )}
                  {activeRemoteWorkspace.view === "services" && (
                    <ServicesPane
                      key={activeRemoteWorkspace.id}
                      connection={activeConnection}
                      cache={activeRemoteWorkspace.servicesCache}
                      onCacheChange={(cache) =>
                        updateServicesCache(activeRemoteWorkspace.id, cache)
                      }
                      onViewLogs={(source) => openLogs(activeRemoteWorkspace.id, source)}
                      focusId={activeRemoteWorkspace.systemdSelectionId}
                    />
                  )}
                  {activeRemoteWorkspace.view === "ports" && (
                    <PortsPane
                      key={activeRemoteWorkspace.id}
                      connection={activeConnection}
                      capabilities={hostCapabilities[activeConnection.id] ?? null}
                      globalSudoEnabled={settings.globalSudoEnabled}
                      cache={activeRemoteWorkspace.portsCache}
                      containersCache={activeRemoteWorkspace.containersCache}
                      onCacheChange={(cache) => updatePortsCache(activeRemoteWorkspace.id, cache)}
                      onContainersCacheChange={(cache) =>
                        updateContainersCache(activeRemoteWorkspace.id, cache)
                      }
                      onOpenSystemd={(systemdSelectionId) =>
                        updateRemoteWorkspace(activeRemoteWorkspace.id, {
                          view: "services",
                          systemdSelectionId,
                        })
                      }
                      onOpenContainer={(containerSelectionId) =>
                        updateRemoteWorkspace(activeRemoteWorkspace.id, {
                          view: "docker",
                          containerSelectionId,
                        })
                      }
                      onViewLogs={(source) => openLogs(activeRemoteWorkspace.id, source)}
                    />
                  )}
                  {activeRemoteWorkspace.view === "docker" && (
                    <DockerPane
                      key={activeRemoteWorkspace.id}
                      connection={activeConnection}
                      cache={activeRemoteWorkspace.containersCache}
                      detailsCache={activeRemoteWorkspace.containerDetailsCache}
                      onCacheChange={(cache) =>
                        updateContainersCache(activeRemoteWorkspace.id, cache)
                      }
                      onDetailsCacheChange={(containerId, details) =>
                        updateContainerDetailsCache(activeRemoteWorkspace.id, containerId, details)
                      }
                      onViewLogs={(source) => openLogs(activeRemoteWorkspace.id, source)}
                      focusId={activeRemoteWorkspace.containerSelectionId}
                    />
                  )}
                  {activeRemoteWorkspace.view === "boot" && (
                    <BootDiagnosticsPane
                      key={activeRemoteWorkspace.id}
                      connection={activeConnection}
                      snapshot={activeRemoteWorkspace.bootDiagnostics}
                      onSnapshotChange={(snapshot) =>
                        updateBootDiagnostics(activeRemoteWorkspace.id, snapshot)
                      }
                      onViewLogs={(source) => openLogs(activeRemoteWorkspace.id, source)}
                    />
                  )}
                  {activeRemoteWorkspace.view === "logs" && (
                    <LogsPane
                      key={activeRemoteWorkspace.id}
                      connection={activeConnection}
                      settings={settings}
                      logTailOptions={settingsContract.logTailOptions}
                      servicesCache={activeRemoteWorkspace.servicesCache}
                      containersCache={activeRemoteWorkspace.containersCache}
                      selectedSource={activeRemoteWorkspace.logSource}
                      onServicesCacheChange={(cache) =>
                        updateServicesCache(activeRemoteWorkspace.id, cache)
                      }
                      onContainersCacheChange={(cache) =>
                        updateContainersCache(activeRemoteWorkspace.id, cache)
                      }
                      onSourceChange={(logSource) =>
                        updateRemoteWorkspace(activeRemoteWorkspace.id, { logSource })
                      }
                    />
                  )}
                  {activeRemoteWorkspace.view === "baselines" && (
                    <BaselinesPane
                      key={activeRemoteWorkspace.id}
                      connection={activeConnection}
                      selectedId={activeRemoteWorkspace.baselineSelectionId}
                      onSelect={(baselineSelectionId) =>
                        updateRemoteWorkspace(activeRemoteWorkspace.id, { baselineSelectionId })
                      }
                    />
                  )}
                  {activeRemoteWorkspace.view === "history" && (
                    <HistoryPane
                      key={activeRemoteWorkspace.id}
                      connection={activeConnection}
                      paused={activeRemoteWorkspace.historyPaused}
                      globalEnabled={settings.globalHistoryEnabled}
                      onPausedChange={(historyPaused) =>
                        updateRemoteWorkspace(activeRemoteWorkspace.id, { historyPaused })
                      }
                      onConnectionChanged={(saved) => {
                        saveConnection(saved);
                        updateRemoteWorkspace(activeRemoteWorkspace.id, {
                          connectionSnapshot: {
                            ...activeRemoteWorkspace.connectionSnapshot,
                            historyEnabled: saved.historyEnabled,
                            updatedAt: saved.updatedAt,
                          },
                        });
                      }}
                      onPaste={pasteIntoTerminal}
                      canPaste={Boolean(activeRemoteWorkspace.sessionId)}
                    />
                  )}
                  {activeRemoteWorkspace.view === "scratchpad" && (
                    <ScratchpadPane key={activeRemoteWorkspace.id} connection={activeConnection} />
                  )}
                </>
              )}
            </div>
          </section>
        )}

        {settingsOpen ? (
          <SettingsPane
            settings={settings}
            defaults={settingsContract.defaults}
            logTailOptions={settingsContract.logTailOptions}
            environment={environment}
            onSaved={(saved) => {
              setSettingsContract({ ...settingsContract, current: saved });
              setSettingsDirty(false);
            }}
            onClose={closeSettings}
            onDirtyChange={setSettingsDirty}
          />
        ) : activeWorkspace ? null : bootError ? (
          <ErrorState message={bootError} />
        ) : (
          <section className="empty-workspace">
            <h1>{connections.length ? "Select a connection" : "No connections yet"}</h1>
            <p>
              {connections.length
                ? "Choose a saved connection from the sidebar to open it."
                : "Use Add connection in the sidebar to save an SSH destination."}
              {!!localShells.length && " Local terminal opens a shell on this machine."}
            </p>
            <div className="empty-shortcuts">
              <span className="empty-shortcut">
                <kbd>Ctrl</kbd>
                <kbd>Shift</kbd>
                <kbd>P</kbd> Command palette
              </span>
            </div>
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
          groups={connectionGroups}
          knownTags={knownTags}
          globalSudoEnabled={settings.globalSudoEnabled}
          onClose={() => setDialogConnection(null)}
          onSaved={saveConnection}
        />
      )}

      {connectionGroupsOpen && (
        <ConnectionGroupsDialog
          groups={connectionGroups}
          tags={knownTags}
          onGroupsChange={setConnectionGroups}
          onTagsChange={setKnownTags}
          onGroupDeleted={handleGroupDeleted}
          onTagUpdated={handleTagUpdated}
          onTagDeleted={handleTagDeleted}
          onClose={() => setConnectionGroupsOpen(false)}
        />
      )}

      {renameTarget && (
        <PromptDialog
          title="Rename Workspace"
          label="Workspace label"
          description={
            isLocalWorkspace(renameTarget)
              ? "Leave it empty to use the shell name."
              : "Leave it empty to use the connection name."
          }
          defaultValue={renameTarget.label ?? duplicateLabel(renameTarget)}
          placeholder={workspaceTargetName(renameTarget)}
          submitLabel="Rename"
          onSubmit={(value) => {
            updateWorkspace(renameTarget.id, { label: value.trim() || null });
            setRenameTarget(null);
          }}
          onClose={() => setRenameTarget(null)}
        />
      )}

      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          danger={confirmState.danger}
          onConfirm={() => {
            const run = confirmState.onConfirm;
            setConfirmState(null);
            run();
          }}
          onClose={() => setConfirmState(null)}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          connections={connections}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          activeView={activeWorkspace?.view ?? null}
          canOpenNewTerminal={canOpenNewTerminal}
          activeWorkspaceIsLocal={Boolean(activeWorkspace && isLocalWorkspace(activeWorkspace))}
          canFocusTerminal={Boolean(activeWorkspace && activeWorkspace.view === "terminal")}
          // Inspection views exist on a Remote Host only, so a local Workspace
          // offers none to go to.
          views={activeRemoteWorkspace ? navigation : []}
          hostCapabilities={hostCapabilities}
          labelForWorkspace={duplicateLabel}
          onClose={() => setPaletteOpen(false)}
          onOpenConnection={(connection) => openConnection(connection)}
          onSelectWorkspace={(workspace) => selectWorkspaceTab(workspace)}
          onSetView={(view) => {
            if (!activeWorkspace) return;
            closeSettings(() => updateWorkspace(activeWorkspace.id, { view }));
          }}
          onNewTerminal={openAnotherTerminal}
          onReconnect={() =>
            activeWorkspace &&
            updateWorkspace(activeWorkspace.id, {
              connectRequested: true,
              reconnectToken: activeWorkspace.reconnectToken + 1,
            })
          }
          onCloseWorkspace={() => activeWorkspace && void closeWorkspace(activeWorkspace.id)}
          onFocusTerminal={enterTerminalFocus}
          onAddConnection={() => setDialogConnection("new")}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
    </div>
  );
}
