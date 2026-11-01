import type { PublishedPortSelection } from "./lib/port-inspector";
import { transitionFocusMode } from "./lib/focus-mode-transition";
import { Search } from "./components/MagnifierIcon";
import { DockerIcon } from "./components/DockerIcon";
import {
  ConnectionSection,
  ResizeDivider,
  SidebarSections,
  usePanelWidth,
} from "./components/ResizablePanels";
import {
  clampPanelSize,
  PANEL_LIMITS,
  restorePanelSizes,
  type PanelSizes,
} from "./lib/panel-layout";
import {
  type ComponentType,
  useCallback,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  RotateCcw,
  Camera,
  ChevronDown,
  Clipboard,
  Columns2,
  Copy,
  FileClock,
  FolderCog,
  History,
  BookOpen,
  Maximize2,
  MoreHorizontal,
  Minimize2,
  Network,
  Pencil,
  Power,
  Plus,
  Rows2,
  Server,
  Settings,
  ShieldAlert,
  SquareTerminal,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import { CommandPalette } from "./components/CommandPalette";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { HostMetrics } from "./components/HostMetrics";
import { displayedHeaderMetrics } from "./lib/header-metrics";
import { UpdateIndicator } from "./components/UpdateIndicator";
import { TerminalTargetMenu } from "./components/TerminalTargetMenu";
import type { TerminalPaneHandle } from "./components/TerminalPane";
import type { TerminalTargetGroup } from "./components/TerminalTargetMenu";
import { WhatsNewDialog } from "./components/WhatsNewDialog";
import { useAppUpdater } from "./hooks/use-app-updater";
import { updateInfo } from "./lib/app-update";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { RemoteShellDialog } from "./components/RemoteShellDialog";
import { ConnectionGroupsDialog } from "./components/ConnectionGroupsDialog";
import { ErrorState, LoadingState } from "./components/PanelState";
import { PromptDialog } from "./components/PromptDialog";
import { HostOsIcon } from "./components/HostOsIcon";
import { LocalShellIcon } from "./components/LocalShellIcon";
import { WindowControls } from "./components/WindowControls";
import { TerminalScratchpad } from "./components/TerminalScratchpad";
import { WorkspaceTabScroller } from "./components/WorkspaceTabScroller";
import { useWorkspacePersistence } from "./hooks/use-workspace-persistence";
import { usePopoverExit } from "./hooks/use-popover-exit";
import { api, errorMessage } from "./lib/api";
import { hostProcessing } from "./lib/host-processing";
import { organizeConnections } from "./lib/connection-organization";
import { tagBadgeStyle } from "./lib/connection-tag-color";
import { connectionTarget } from "./lib/format";
import { detectHostCapabilities } from "./lib/host-capabilities";
import { connectionTargetKey } from "./lib/connection-validation";
import { isWorkspaceShortcutBlocked } from "./lib/terminal-flow";
import { clearScratchpadDraft, quiesceScratchpad, resumeScratchpad } from "./lib/scratchpad-draft";
import {
  createTerminalLayout,
  getTerminalLayoutIds,
  getTerminalPanePixels,
  getResponsiveTerminalGeometry,
  resizeTerminalLayout,
  splitTerminalLayout,
} from "./lib/terminal-layout";
import type { TerminalSplitDirection } from "./lib/terminal-layout";
import {
  deleteTerminalGroup,
  nextTerminalGroupName,
  pruneTerminalGroups,
  renameTerminalGroup,
  terminalGroupForWorkspace,
  type TerminalGroup,
} from "./lib/terminal-groups";
import {
  defaultLocalShell,
  needsAdministratorSetup,
  offeredLocalShells,
} from "./lib/offered-local-shells";
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
  terminalStateLabel,
  workspaceTargetName,
} from "./lib/workspace-target";
import { DockerPane } from "./pages/DockerPane";
import { BootDiagnosticsPane } from "./pages/BootDiagnosticsPane";
import { HistoryPane } from "./pages/HistoryPane";
import { LogsPane } from "./pages/LogsPane";
import { PortsPane } from "./pages/PortsPane";
import { ServicesPane } from "./pages/ServicesPane";
import { navigateSystemdExplorer } from "./lib/systemd-units";
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
  AdministratorTerminalStatus,
  LocalShellProfile,
  LogSourceSelection,
  RemoteWorkspace,
  RemoteShellProfile,
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

function administratorTerminalNote(status: AdministratorTerminalStatus): string {
  switch (status) {
    case "disabled":
      return "One-time setup: in Windows Settings, open System > Advanced, turn on Enable sudo, and choose Inline. Then reopen this menu.";
    case "unsupportedMode":
      return "In Windows Settings, open System > Advanced and change the sudo option to Inline. Then reopen this menu.";
    case "unsupportedWindows":
      return "Requires Windows 11 version 24H2 or later.";
    case "available":
      return "No supported administrator shell is installed.";
  }
}

const navigation: {
  id: WorkspaceView;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}[] = [
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "services", label: "Systemd", icon: Server },
  { id: "ports", label: "Ports", icon: Network },
  { id: "docker", label: "Docker", icon: DockerIcon },
  { id: "boot", label: "Boot", icon: Power },
  { id: "logs", label: "Logs", icon: FileClock },
  { id: "baselines", label: "Baselines", icon: Camera },
  { id: "history", label: "History", icon: History },
];

const TerminalPane = lazy(() =>
  import("./components/TerminalPane").then((module) => ({ default: module.TerminalPane })),
);
const WindowsServicesPane = lazy(() =>
  import("./pages/WindowsServicesPane").then((module) => ({ default: module.WindowsServicesPane })),
);

/// Fixed geometry for a popover anchored to its trigger: a consistent 6px gap
/// below the trigger (flipping above when the window lacks the room), clamped
/// to 8px window-edge gutters, and a max height that keeps long lists
/// scrolling inside the popup instead of off the window.
interface AnchoredPopover {
  top?: number;
  bottom?: number;
  right: number;
  maxHeight: number;
}

const POPOVER_GAP = 6;
const POPOVER_GUTTER = 8;

function anchoredPopoverAt(rect: DOMRect, width: number, preferredHeight: number): AnchoredPopover {
  const below = window.innerHeight - rect.bottom - POPOVER_GAP - POPOVER_GUTTER;
  const above = rect.top - POPOVER_GAP - POPOVER_GUTTER;
  const useAbove = below < preferredHeight && above > below;
  return {
    right: Math.max(
      POPOVER_GUTTER,
      Math.min(window.innerWidth - rect.right, window.innerWidth - width - POPOVER_GUTTER),
    ),
    ...(useAbove
      ? { bottom: window.innerHeight - rect.top + POPOVER_GAP }
      : { top: rect.bottom + POPOVER_GAP }),
    maxHeight: Math.max(0, Math.min(preferredHeight, useAbove ? above : below)),
  };
}

export function App() {
  const [remoteShellRequest, setRemoteShellRequest] = useState<{
    connection: SavedConnection;
    split: boolean;
  } | null>(null);
  const [connections, setConnections] = useState<SavedConnection[]>([]);
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const [localShells, setLocalShells] = useState<LocalShellProfile[]>([]);
  const [administratorTerminalStatus, setAdministratorTerminalStatus] =
    useState<AdministratorTerminalStatus>("unsupportedWindows");
  const [connectionGroups, setConnectionGroups] = useState<ConnectionGroup[]>([]);
  const [knownTags, setKnownTags] = useState<ConnectionTag[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [systemdPortFocus, setSystemdPortFocus] = useState<{
    workspaceId: string;
    unit: string;
  } | null>(null);
  useEffect(() => {
    if (
      systemdPortFocus &&
      workspaces.find((workspace) => workspace.id === systemdPortFocus.workspaceId)?.view !==
        "ports"
    )
      setSystemdPortFocus(null);
  }, [workspaces, systemdPortFocus]);
  const [portFocus, setPortFocus] = useState<
    (PublishedPortSelection & { workspaceId: string }) | null
  >(null);
  useEffect(() => {
    if (
      portFocus &&
      workspaces.find((workspace) => workspace.id === portFocus.workspaceId)?.view !== "ports"
    )
      setPortFocus(null);
  }, [workspaces, portFocus]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [settingsContract, setSettingsContract] = useState<SettingsContract | null>(null);
  const [environment, setEnvironment] = useState(emptyEnvironment);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openingDocumentation, setOpeningDocumentation] = useState(false);
  const openingDocumentationRef = useRef(false);
  const [documentationError, setDocumentationError] = useState<string | null>(null);
  const [hostSearch, setHostSearch] = useState("");
  const [ungroupedCollapsed, setUngroupedCollapsed] = useState(false);
  const [connectionGroupsOpen, setConnectionGroupsOpen] = useState(false);
  const [hostCapabilities, setHostCapabilities] = useState<Record<string, HostCapabilities>>({});
  const [hostMenuConnectionId, setHostMenuConnectionId] = useState<string | null>(null);
  const [hostMenuPosition, setHostMenuPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [dialogConnection, setDialogConnection] = useState<SavedConnection | "new" | null>(null);
  const [panelSizes, setPanelSizes] = useState<PanelSizes>({});
  const shellSize = usePanelWidth();
  const railMax = Math.max(
    PANEL_LIMITS.connections.min,
    Math.min(PANEL_LIMITS.connections.max, (shellSize.width || 840) - 360),
  );
  const railWidth = clampPanelSize(
    panelSizes.connections ?? (shellSize.width > 0 && shellSize.width <= 1120 ? 216 : 244),
    PANEL_LIMITS.connections.min,
    railMax,
  );
  const setPanelSize = useCallback((key: string, size: number | null) => {
    setPanelSizes((current) => {
      const next = { ...current };
      if (size === null) delete next[key];
      else next[key] = size;
      return next;
    });
  }, []);
  const panelLayout = useMemo(
    () => ({ sizes: panelSizes, setSize: setPanelSize }),
    [panelSizes, setPanelSize],
  );
  const [terminalFocusMode, setTerminalFocusMode] = useState(false);
  const [terminalGroups, setTerminalGroups] = useState<TerminalGroup[]>([]);
  const [splitDirection, setSplitDirection] = useState<TerminalSplitDirection>("vertical");
  const [splitMenuOpen, setSplitMenuOpen] = useState(false);
  const [newTerminalMenuOpen, setNewTerminalMenuOpen] = useState(false);
  const [scratchpadOpen, setScratchpadOpen] = useState(false);
  // Focus goes back to the control that opened the menu, so dismissing with
  // Escape leaves the keyboard where it started.
  const newTerminalButtonRef = useRef<HTMLButtonElement>(null);
  const splitMenuButtonRef = useRef<HTMLButtonElement>(null);
  const scratchpadButtonRef = useRef<HTMLButtonElement>(null);
  // The closing transitions keep fading popovers mounted for a beat without
  // delaying focus return or dismissal itself.
  const { present: newTerminalMenuPresent, closing: newTerminalMenuClosing } =
    usePopoverExit(newTerminalMenuOpen);
  const { present: splitMenuPresent, closing: splitMenuClosing } = usePopoverExit(splitMenuOpen);
  const { present: scratchpadPresent, closing: scratchpadClosing } = usePopoverExit(scratchpadOpen);
  const terminalGroupActiveWorkspaceRef = useRef(new Map<string, string>());
  const closingWorkspaceIdsRef = useRef(new Set<string>());
  const terminalLayoutViewportRef = useRef<HTMLDivElement>(null);
  const [terminalLayoutViewport, setTerminalLayoutViewport] = useState({
    width: Number.POSITIVE_INFINITY,
    height: Number.POSITIVE_INFINITY,
  });
  // Anchored geometry for the terminal popovers, measured when they open.
  const [newTerminalMenuAt, setNewTerminalMenuAt] = useState<AnchoredPopover | null>(null);
  const [splitMenuAt, setSplitMenuAt] = useState<AnchoredPopover | null>(null);
  const [scratchpadAt, setScratchpadAt] = useState<AnchoredPopover | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalActivity, setTerminalActivity] = useState<Record<string, "output" | "bell">>({});
  const [terminalProcessing, setTerminalProcessing] = useState<Record<string, boolean>>({});
  const hostOperations = useSyncExternalStore(hostProcessing.subscribe, hostProcessing.getSnapshot);
  const [terminalFindRequests, setTerminalFindRequests] = useState<Record<string, number>>({});
  const [terminalHasSelection, setTerminalHasSelection] = useState<Record<string, boolean>>({});
  const terminalHandlesRef = useRef(new Map<string, TerminalPaneHandle>());
  const [renameTarget, setRenameTarget] = useState<Workspace | null>(null);
  const [renameGroupTarget, setRenameGroupTarget] = useState<TerminalGroup | null>(null);
  // One update lifecycle for the whole application: one timer, one in-flight
  // check, no matter how many Workspaces are open. Defaults to on while
  // Settings is still loading so a slow first read never skips the first check.
  const updater = useAppUpdater(settingsContract?.current.automaticUpdateChecks ?? true);
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

  // What the asynchronous close and delete paths read once they have awaited
  // the backend. Both replace the whole Workspace list rather than patching
  // one entry, and both start from a confirmation callback created in an
  // earlier render, so reading these from the closure wrote back whatever they
  // held when the dialog opened. A Workspace opened, or a session state that
  // changed, while the request was in flight was inside neither the old list
  // nor the replacement, and disappeared.
  const workspaceStateRef = useRef({
    workspaces,
    activeWorkspaceId,
    terminalGroups,
    terminalFocusMode,
  });
  useEffect(() => {
    workspaceStateRef.current = {
      workspaces,
      activeWorkspaceId,
      terminalGroups,
      terminalFocusMode,
    };
  }, [workspaces, activeWorkspaceId, terminalGroups, terminalFocusMode]);

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
          const localShellCatalog =
            localShellsResult.status === "fulfilled"
              ? localShellsResult.value
              : { profiles: [], administratorStatus: "unsupportedWindows" as const };
          const detectedShells = localShellCatalog.profiles;
          setLocalShells(detectedShells);
          setAdministratorTerminalStatus(localShellCatalog.administratorStatus);
          const restored = restoreWorkspaceState(
            connectionsResult.status === "fulfilled" ? connectionsResult.value : [],
            workspaceStateResult.status === "fulfilled"
              ? workspaceStateResult.value
              : { workspaces: [], activeWorkspaceId: null, terminalLayout: null },
            detectedShells,
          );
          if (
            settingsResult.status === "fulfilled" &&
            settingsResult.value.current.localTerminalMode
          ) {
            const startupSettings = settingsResult.value.current;
            const shell = defaultLocalShell(
              offeredLocalShells(detectedShells, startupSettings.hiddenLocalShells ?? []),
              startupSettings.defaultLocalShellId ?? null,
            );
            if (shell) {
              const existing = restored.workspaces.find(
                (workspace) => isLocalWorkspace(workspace) && workspace.shell.id === shell.id,
              );
              const workspace = existing ?? createLocalWorkspace(shell);
              if (!existing) restored.workspaces.push(workspace);
              workspace.view = "terminal";
              restored.activeWorkspaceId = workspace.id;
              setTerminalFocusMode(true);
            }
          }
          if (workspaceStateResult.status === "fulfilled")
            setPanelSizes(restorePanelSizes(workspaceStateResult.value.panelSizes));
          setWorkspaces(restored.workspaces);
          setActiveWorkspaceId(restored.activeWorkspaceId);
          setTerminalGroups(restored.terminalGroups);
          setWorkspacePersistenceReady(
            connectionsResult.status === "fulfilled" && workspaceStateResult.status === "fulfilled",
          );
          if (workspaceStateResult.status === "rejected") {
            setActionError(
              `Could not restore Workspaces: ${errorMessage(workspaceStateResult.reason)}`,
            );
          }
          if (connectionsResult.status === "fulfilled") {
            connectionsRef.current = connectionsResult.value;
            setConnections(connectionsResult.value);
            for (const connection of connectionsResult.value) {
              void api
                .cachedCapabilities(connection.id)
                .then((capabilities) => {
                  if (
                    current &&
                    capabilities &&
                    connectionsRef.current.some(
                      (saved) =>
                        saved.id === connection.id &&
                        connectionTargetKey(saved) === connectionTargetKey(connection),
                    )
                  )
                    rememberCapabilities(capabilities);
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
  const tabArrangementKey = [
    terminalFocusMode ? "focus" : "normal",
    ...workspaces.map((workspace) => workspace.id),
    ...terminalGroups.map((group) => `${group.id}:${getTerminalLayoutIds(group.layout).join(",")}`),
  ].join("|");
  const activeTerminalEnded =
    activeWorkspace?.state === "disconnected" || activeWorkspace?.state === "error";
  // Inspection views, Enhanced History, and Saved Connection actions belong to
  // a remote Workspace. A local one is terminal-only.
  const activeRemoteWorkspace =
    activeWorkspace && isRemoteWorkspace(activeWorkspace) ? activeWorkspace : null;
  const activeConnection = activeRemoteWorkspace?.connectionSnapshot ?? null;
  const windowsWorkspace =
    !!activeRemoteWorkspace &&
    (!!activeRemoteWorkspace.remoteShell ||
      hostCapabilities[activeRemoteWorkspace.connectionId]?.osId === "windows");
  // Local workspaces offer Terminal only; notes live in the terminal toolbar.
  const offeredNavigation =
    activeWorkspace && isLocalWorkspace(activeWorkspace)
      ? navigation.filter((item) => item.id === "terminal")
      : windowsWorkspace
        ? navigation
            .filter((item) => ["terminal", "services", "ports", "docker", "logs"].includes(item.id))
            .map((item) => (item.id === "services" ? { ...item, label: "Services" } : item))
        : navigation;
  const activeSavedConnection = activeRemoteWorkspace
    ? (connections.find((connection) => connection.id === activeRemoteWorkspace.connectionId) ??
      null)
    : null;
  // "New terminal" asks which target to open, so it needs a target to offer
  // rather than a compatible Workspace to copy. Having nothing saved and no
  // shell installed is the only case with nothing to choose from.
  //
  // Every launcher offers the same set: each installed profile except the ones
  // turned off in Settings. The catalog itself stays complete, because it is
  // also what a restored Workspace is checked against — hiding a shell must
  // never cost someone the Workspace that was already running it.
  const offeredShells = offeredLocalShells(
    localShells,
    settingsContract?.current.hiddenLocalShells ?? [],
  );
  const canOpenNewTerminal = connections.length > 0 || offeredShells.length > 0;
  const standardLocalShells = offeredShells.filter((shell) => !shell.elevated);
  const administratorLocalShells = offeredShells.filter((shell) => shell.elevated);
  const administratorGroupOffered =
    administratorLocalShells.length > 0 ||
    needsAdministratorSetup(
      localShells,
      settingsContract?.current.hiddenLocalShells ?? [],
      administratorTerminalStatus,
    );
  const activeTerminalGroup = terminalFocusMode
    ? terminalGroupForWorkspace(terminalGroups, activeWorkspaceId)
    : null;
  const activeTerminalIds = activeTerminalGroup
    ? getTerminalLayoutIds(activeTerminalGroup.layout)
    : [];
  const terminalSplitMode = activeTerminalGroup !== null && activeTerminalIds.length > 1;
  const visibleTerminalIds =
    terminalFocusMode && activeTerminalGroup
      ? activeTerminalIds
      : activeWorkspace
        ? [activeWorkspace.id]
        : [];
  const groupedWorkspaceIds = new Set(
    terminalGroups.flatMap((group) => getTerminalLayoutIds(group.layout)),
  );
  const ungroupedWorkspaces = workspaces.filter(
    (workspace) => !groupedWorkspaceIds.has(workspace.id),
  );
  const terminalGeometry =
    terminalSplitMode && activeTerminalGroup
      ? getResponsiveTerminalGeometry(activeTerminalGroup.layout, terminalLayoutViewport)
      : { panes: {}, dividers: [] };
  const terminalPaneRects = terminalGeometry.panes;
  const existingSplitCandidates = terminalFocusMode
    ? ungroupedWorkspaces.filter((workspace) => workspace.id !== activeWorkspaceId)
    : [];
  useWorkspacePersistence({
    ready: workspacePersistenceReady,
    workspaces,
    activeWorkspaceId,
    terminalGroups,
    panelSizes,
    onError: setActionError,
  });

  useEffect(() => {
    if (!activeWorkspaceId || activeWorkspace?.view !== "terminal" || settingsOpen) return;
    setTerminalActivity((current) => {
      if (!current[activeWorkspaceId]) return current;
      const next = { ...current };
      delete next[activeWorkspaceId];
      return next;
    });
  }, [activeWorkspaceId, activeWorkspace?.view, settingsOpen]);

  useEffect(() => {
    const group = terminalGroupForWorkspace(terminalGroups, activeWorkspaceId);
    if (group && activeWorkspaceId) {
      terminalGroupActiveWorkspaceRef.current.set(group.id, activeWorkspaceId);
    }
  }, [activeWorkspaceId, terminalGroups]);

  useEffect(() => {
    const element = terminalLayoutViewportRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    function rememberSize(width: number, height: number) {
      setTerminalLayoutViewport((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    }

    rememberSize(element.clientWidth, element.clientHeight);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) rememberSize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading, activeWorkspace?.id]);

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
          restored: false,
          reconnectToken: activeWorkspace.reconnectToken + 1,
        });
      }
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.key.toLowerCase() === "f" &&
        activeWorkspace?.view === "terminal"
      ) {
        event.preventDefault();
        setTerminalFindRequests((current) => ({
          ...current,
          [activeWorkspace.id]: (current[activeWorkspace.id] ?? 0) + 1,
        }));
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
      setHostMenuPosition(null);
    }

    function dismissMenuWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setHostMenuConnectionId(null);
        setHostMenuPosition(null);
      }
    }

    document.addEventListener("pointerdown", dismissMenu);
    document.addEventListener("keydown", dismissMenuWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismissMenu);
      document.removeEventListener("keydown", dismissMenuWithKeyboard);
    };
  }, [hostMenuConnectionId]);

  useEffect(() => {
    if (!newTerminalMenuOpen) return;
    function pointerDown(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-new-terminal-menu]")) return;
      setNewTerminalMenuOpen(false);
    }
    // The anchor geometry was measured at open time; resizing invalidates it,
    // so the menu dismisses instead of floating away from its control, and
    // the keyboard comes back to the trigger with it.
    function dismissOnResize() {
      setNewTerminalMenuOpen(false);
      newTerminalButtonRef.current?.focus();
    }
    document.addEventListener("mousedown", pointerDown);
    window.addEventListener("resize", dismissOnResize);
    return () => {
      document.removeEventListener("mousedown", pointerDown);
      window.removeEventListener("resize", dismissOnResize);
    };
  }, [newTerminalMenuOpen]);

  // The Scratchpad popover belongs to the terminal view; leaving it (Settings,
  // an inspection page, or the workspace closing) closes the popover with it.
  useEffect(() => {
    if (settingsOpen || activeWorkspace?.view !== "terminal") setScratchpadOpen(false);
  }, [settingsOpen, activeWorkspace?.view]);

  useLayoutEffect(() => {
    if (!scratchpadOpen || settingsOpen || activeWorkspace?.view !== "terminal") return;
    const position = () => {
      const rect = scratchpadButtonRef.current?.getBoundingClientRect();
      if (rect)
        setScratchpadAt(anchoredPopoverAt(rect, Math.min(320, window.innerWidth - 40), 380));
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [
    scratchpadOpen,
    settingsOpen,
    activeWorkspace?.view,
    activeWorkspace?.id,
    terminalFocusMode,
    shellSize.width,
  ]);

  useLayoutEffect(() => {
    if (!splitMenuOpen || !terminalFocusMode) return;
    const rect = splitMenuButtonRef.current?.getBoundingClientRect();
    if (rect) setSplitMenuAt(anchoredPopoverAt(rect, 264, 480));
  }, [splitMenuOpen, terminalFocusMode]);

  useEffect(() => {
    if (!splitMenuOpen) return;

    function dismissMenu(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-terminal-split-menu]")) return;
      setSplitMenuOpen(false);
    }

    function dismissMenuWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSplitMenuOpen(false);
        splitMenuButtonRef.current?.focus();
      }
    }

    function dismissOnResize() {
      setSplitMenuOpen(false);
      splitMenuButtonRef.current?.focus();
    }

    document.addEventListener("pointerdown", dismissMenu);
    document.addEventListener("keydown", dismissMenuWithKeyboard);
    window.addEventListener("resize", dismissOnResize);
    return () => {
      document.removeEventListener("pointerdown", dismissMenu);
      document.removeEventListener("keydown", dismissMenuWithKeyboard);
      window.removeEventListener("resize", dismissOnResize);
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

  const processingConnections = new Set(hostOperations);
  for (const workspace of workspaces) {
    if (
      isRemoteWorkspace(workspace) &&
      (terminalProcessing[workspace.id] || workspace.state === "connecting")
    ) {
      processingConnections.add(workspace.connectionId);
    }
  }

  function workspaceProcessing(workspace: Workspace) {
    return (
      workspace.state === "connecting" ||
      !!terminalProcessing[workspace.id] ||
      (isRemoteWorkspace(workspace) && hostOperations.has(workspace.connectionId))
    );
  }

  function workspaceStatus(workspace: Workspace) {
    return `${terminalStateLabel(workspace)}${workspaceProcessing(workspace) && workspace.state !== "connecting" ? ", processing" : ""}`;
  }

  function connectionStatus(connectionId: string) {
    const state = connectionSessionStates[connectionId];
    return `${state ? `Terminal ${state}` : "No open terminal"}${processingConnections.has(connectionId) ? ", processing" : ""}`;
  }

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
    transitionFocusMode("enter", () => {
      setSplitMenuOpen(false);
      setNewTerminalMenuOpen(false);
      setTerminalFocusMode(true);
    });
  }

  function exitTerminalFocus() {
    transitionFocusMode("exit", () => {
      setSplitMenuOpen(false);
      setNewTerminalMenuOpen(false);
      setTerminalFocusMode(false);
    });
  }

  function openScratchpad() {
    if (!activeWorkspace) return;
    closeSettings(() => {
      updateWorkspace(activeWorkspace.id, { view: "terminal" });
      setNewTerminalMenuOpen(false);
      setSplitMenuOpen(false);
      setScratchpadOpen(true);
    });
  }

  function selectTerminalGroup(group: TerminalGroup) {
    const ids = getTerminalLayoutIds(group.layout);
    const remembered = terminalGroupActiveWorkspaceRef.current.get(group.id);
    const nextId = remembered && ids.includes(remembered) ? remembered : ids[0];
    if (!nextId) return;
    terminalGroupActiveWorkspaceRef.current.set(group.id, nextId);
    setActiveWorkspaceId(nextId);
    updateWorkspace(nextId, { view: "terminal" });
    setSplitMenuOpen(false);
  }

  function selectWorkspaceTab(workspace: Workspace) {
    closeSettings(() => {
      setActiveWorkspaceId(workspace.id);
      if (terminalFocusMode) {
        const group = terminalGroupForWorkspace(terminalGroups, workspace.id);
        if (group) terminalGroupActiveWorkspaceRef.current.set(group.id, workspace.id);
        updateWorkspace(workspace.id, { view: "terminal" });
      }
    });
  }

  function splitWithExistingTerminal(workspace: Workspace) {
    if (!activeWorkspace || !terminalFocusMode) return;
    updateWorkspace(workspace.id, { view: "terminal" });
    const groupId = activeTerminalGroup?.id ?? crypto.randomUUID();
    setTerminalGroups((current) =>
      activeTerminalGroup
        ? current.map((item) =>
            item.id === activeTerminalGroup.id
              ? {
                  ...item,
                  layout: splitTerminalLayout(
                    item.layout,
                    activeWorkspace.id,
                    workspace.id,
                    splitDirection,
                  ),
                }
              : item,
          )
        : [
            ...current,
            {
              id: groupId,
              name: nextTerminalGroupName(current, duplicateLabel(activeWorkspace)),
              layout: splitTerminalLayout(
                createTerminalLayout(activeWorkspace.id),
                activeWorkspace.id,
                workspace.id,
                splitDirection,
              ),
            },
          ],
    );
    terminalGroupActiveWorkspaceRef.current.set(groupId, workspace.id);
    setActiveWorkspaceId(workspace.id);
    setSplitMenuOpen(false);
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
    const target = connectionsRef.current.find((connection) => connection.id === connectionId);
    void detectHostCapabilities(api, connectionId)
      .then((capabilities) => {
        const current = connectionsRef.current.find((connection) => connection.id === connectionId);
        if (target && current && connectionTargetKey(target) === connectionTargetKey(current))
          rememberCapabilities(capabilities);
      })
      .catch(() => undefined)
      .finally(() => {
        capabilityDetectionsRef.current.delete(connectionId);
        const current = connectionsRef.current.find((connection) => connection.id === connectionId);
        if (target && current && connectionTargetKey(target) !== connectionTargetKey(current)) {
          detectConnectionCapabilities(connectionId);
        }
      });
  }

  function openLogs(id: string, logSource: LogSourceSelection) {
    updateRemoteWorkspace(id, { view: "logs", logSource });
  }

  function openSystemd(id: string, unit: string) {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace || !isRemoteWorkspace(workspace)) return;
    updateRemoteWorkspace(id, {
      view: "services",
      systemdSelectionId: unit,
      systemdExplorer: navigateSystemdExplorer(
        workspace.systemdExplorer,
        workspace.systemdSelectionId,
        unit,
      ),
    });
  }

  function splitWithNewWorkspace(workspace: Workspace) {
    if (!activeWorkspace || !terminalFocusMode) return;
    setWorkspaces((current) => [...current, workspace]);
    const groupId = activeTerminalGroup?.id ?? crypto.randomUUID();
    setTerminalGroups((current) =>
      activeTerminalGroup
        ? current.map((item) =>
            item.id === activeTerminalGroup.id
              ? {
                  ...item,
                  layout: splitTerminalLayout(
                    item.layout,
                    activeWorkspace.id,
                    workspace.id,
                    splitDirection,
                  ),
                }
              : item,
          )
        : [
            ...current,
            {
              id: groupId,
              name: nextTerminalGroupName(current, duplicateLabel(activeWorkspace)),
              layout: splitTerminalLayout(
                createTerminalLayout(activeWorkspace.id),
                activeWorkspace.id,
                workspace.id,
                splitDirection,
              ),
            },
          ],
    );
    terminalGroupActiveWorkspaceRef.current.set(groupId, workspace.id);
    setActiveWorkspaceId(workspace.id);
    setSplitMenuOpen(false);
  }

  function removeTerminalGroup(groupId: string) {
    if (!terminalGroups.some((group) => group.id === groupId)) return;
    const removingActiveGroup = activeTerminalGroup?.id === groupId;
    const nextGroups = deleteTerminalGroup(terminalGroups, groupId);
    terminalGroupActiveWorkspaceRef.current.delete(groupId);
    setTerminalGroups(nextGroups);
    if (terminalFocusMode && removingActiveGroup && activeWorkspaceId) {
      updateWorkspace(activeWorkspaceId, { view: "terminal" });
    }
  }

  function confirmUngroup(group: TerminalGroup) {
    setConfirmState({
      title: "Ungroup terminals",
      message: `Ungroup “${group.name}”? Its terminals will stay open as separate tabs.`,
      confirmLabel: "Ungroup",
      onConfirm: () => removeTerminalGroup(group.id),
    });
  }

  function openConnection(connection: SavedConnection, forceNew = false, split = false) {
    closeSettings(() => {
      if (!forceNew && !split) {
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
      if (
        hostCapabilities[connection.id]?.osId &&
        hostCapabilities[connection.id]?.osId !== "windows"
      ) {
        const workspace = createRemoteWorkspace(connection);
        if (split) splitWithNewWorkspace(workspace);
        else openWorkspace(workspace);
      } else {
        setSplitMenuOpen(false);
        setRemoteShellRequest({ connection, split });
      }
    });
  }

  function selectRemoteShell(shell: RemoteShellProfile | null) {
    if (!remoteShellRequest) return;
    const workspace = createRemoteWorkspace(remoteShellRequest.connection, shell);
    if (remoteShellRequest.split) splitWithNewWorkspace(workspace);
    else openWorkspace(workspace);
    setRemoteShellRequest(null);
  }

  /// Opens a local Windows shell as its own Workspace. Each launch is a new
  /// shell, so there is nothing to reuse, and no Saved Connection is involved.
  function openLocalShell(shell: LocalShellProfile) {
    closeSettings(() => openWorkspace(createLocalWorkspace(shell)));
  }

  function openWorkspace(workspace: Workspace) {
    setWorkspaces((current) => [...current, workspace]);
    setActiveWorkspaceId(workspace.id);
  }

  /// Opens the chooser under its own control, measured at the moment it opens:
  /// a consistent gap below the button, flipped above it when the window has
  /// no room, and clamped so neither edge pushes the menu off screen.
  const NEW_TERMINAL_MENU_WIDTH = 248;
  const NEW_TERMINAL_MENU_HEIGHT = 420;
  function openNewTerminalMenu() {
    if (newTerminalMenuOpen) {
      setNewTerminalMenuOpen(false);
      return;
    }
    const rect = newTerminalButtonRef.current?.getBoundingClientRect();
    if (rect) {
      setNewTerminalMenuAt(
        anchoredPopoverAt(rect, NEW_TERMINAL_MENU_WIDTH, NEW_TERMINAL_MENU_HEIGHT),
      );
    }
    setNewTerminalMenuOpen(true);
    void api
      .listLocalShells()
      .then((catalog) => {
        setLocalShells(catalog.profiles);
        setAdministratorTerminalStatus(catalog.administratorStatus);
        if (
          !connections.length &&
          !offeredLocalShells(catalog.profiles, settingsContract?.current.hiddenLocalShells ?? [])
            .length
        ) {
          setActionError(
            "No enabled local terminals are available. Check installed shells and Settings.",
          );
          setNewTerminalMenuOpen(false);
        }
      })
      .catch((error) => setActionError(`Could not refresh local shells: ${errorMessage(error)}`));
  }

  /// Split's chooser anchors to its own button with the same geometry.
  function openSplitMenu() {
    if (splitMenuOpen) {
      setSplitMenuOpen(false);
      return;
    }
    const rect = splitMenuButtonRef.current?.getBoundingClientRect();
    if (rect) setSplitMenuAt(anchoredPopoverAt(rect, 264, 480));
    setSplitMenuOpen(true);
  }

  /// Split's targets. It keeps its own order and its own extra group: a split
  /// can adopt a terminal that is already open, which "New terminal" cannot,
  /// because opening is the whole point of that menu.
  const splitTargetGroups: TerminalTargetGroup[] = [
    {
      label: "Existing terminals",
      options: existingSplitCandidates.map((workspace) => ({
        id: workspace.id,
        label: duplicateLabel(workspace),
        icon: workspaceMark(workspace),
        onSelect: () => splitWithExistingTerminal(workspace),
      })),
    },
    {
      label: "New local terminal",
      options: standardLocalShells.map((shell) => ({
        id: shell.id,
        label: shell.label,
        icon: <LocalShellIcon kind={shell.kind} elevated={shell.elevated} />,
        onSelect: () => splitWithNewWorkspace(createLocalWorkspace(shell)),
      })),
    },
    {
      label: "Run as administrator",
      options: administratorLocalShells.map((shell) => ({
        id: shell.id,
        label: shell.label,
        icon: <LocalShellIcon kind={shell.kind} elevated={shell.elevated} />,
        onSelect: () => splitWithNewWorkspace(createLocalWorkspace(shell)),
      })),
    },
    {
      label: "New from Saved Connections",
      options: connections.map((connection) => ({
        id: connection.id,
        label: connection.displayName,
        icon: (
          <HostOsIcon
            osId={hostCapabilities[connection.id]?.osId}
            osName={hostCapabilities[connection.id]?.osName}
          />
        ),
        onSelect: () => openConnection(connection, true, true),
      })),
    },
  ];
  const canSplitTerminal = splitTargetGroups.some((group) => group.options.length > 0);

  /// The targets "New terminal" offers: everything saved, plus every shell this
  /// machine actually has. Each one opens its own Workspace, so choosing the
  /// active target again is a second independent terminal rather than a no-op.
  const newTerminalGroups: TerminalTargetGroup[] = [
    {
      label: "Saved Connections",
      options: connections.map((connection) => ({
        id: connection.id,
        label: connection.displayName,
        icon: (
          <HostOsIcon
            osId={hostCapabilities[connection.id]?.osId}
            osName={hostCapabilities[connection.id]?.osName}
          />
        ),
        onSelect: () => {
          setNewTerminalMenuOpen(false);
          openConnection(connection, true);
        },
      })),
    },
    {
      label: "Local terminals",
      options: standardLocalShells.map((shell) => ({
        id: shell.id,
        label: shell.label,
        icon: <LocalShellIcon kind={shell.kind} elevated={shell.elevated} />,
        onSelect: () => {
          setNewTerminalMenuOpen(false);
          openLocalShell(shell);
        },
      })),
    },
    {
      label: "Run as administrator",
      options: administratorLocalShells.map((shell) => ({
        id: shell.id,
        label: shell.label,
        icon: <LocalShellIcon kind={shell.kind} elevated={shell.elevated} />,
        onSelect: () => {
          setNewTerminalMenuOpen(false);
          openLocalShell(shell);
        },
      })),
    },
  ];

  function closeWorkspace(id: string) {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) return;
    if (workspace.sessionId) {
      const local = isLocalWorkspace(workspace);
      setConfirmState({
        title: "Close workspace",
        message: local
          ? `Stop the local shell and close “${duplicateLabel(workspace)}”?`
          : `Disconnect the SSH session and close “${duplicateLabel(workspace)}”?`,
        confirmLabel: local ? "Stop & close" : "Disconnect & close",
        danger: true,
        onConfirm: () => void performCloseWorkspace(id),
      });
      return;
    }
    void performCloseWorkspace(id);
  }

  async function performCloseWorkspace(id: string) {
    const workspace = workspaceStateRef.current.workspaces.find((item) => item.id === id);
    if (!workspace || closingWorkspaceIdsRef.current.has(id)) return;
    closingWorkspaceIdsRef.current.add(id);
    setActionError(null);
    if (workspace.sessionId) await api.closeSession(workspace.sessionId).catch(() => undefined);
    // Whatever the list holds now, not what it held when the confirmation was
    // set up or before the close round trip.
    const current = workspaceStateRef.current;
    const index = current.workspaces.findIndex((item) => item.id === id);
    const remaining = current.workspaces.filter((item) => item.id !== id);
    const previousGroup = terminalGroupForWorkspace(current.terminalGroups, id);
    const nextGroups = pruneTerminalGroups(
      current.terminalGroups,
      new Set(remaining.map((item) => item.id)),
    );
    const remainingGroup = previousGroup
      ? nextGroups.find((group) => group.id === previousGroup.id)
      : null;
    const remainingSplitIds = remainingGroup
      ? getTerminalLayoutIds(remainingGroup.layout)
      : previousGroup
        ? getTerminalLayoutIds(previousGroup.layout).filter((memberId) => memberId !== id)
        : [];
    const closingActiveWorkspace = current.activeWorkspaceId === id;
    const keepFocusGroup = current.terminalFocusMode && previousGroup;
    const nextActive = closingActiveWorkspace
      ? ((keepFocusGroup ? remaining.find((item) => item.id === remainingSplitIds[0]) : null) ??
        remaining[Math.min(index, remaining.length - 1)] ??
        null)
      : null;
    setWorkspaces(
      keepFocusGroup && nextActive
        ? remaining.map((item) =>
            item.id === nextActive.id ? { ...item, view: "terminal" } : item,
          )
        : remaining,
    );
    if (closingActiveWorkspace) {
      setActiveWorkspaceId(nextActive?.id ?? null);
    }
    setTerminalGroups(nextGroups);
    if (!remaining.length) exitTerminalFocus();
    closingWorkspaceIdsRef.current.delete(id);
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
    connectionsRef.current = connectionsRef.current.filter((item) => item.id !== connection.id);
    // The record is gone from the database, so take it out of the rail before
    // anything else awaits. That also closes the only door a new Workspace for
    // it could still come through while its sessions are being torn down, which
    // is what lets the loop below be a single pass.
    setConnections((current) => current.filter((item) => item.id !== connection.id));
    setHostCapabilities((current) => {
      const next = { ...current };
      delete next[connection.id];
      return next;
    });

    // Tearing down a pty is a round trip, and there is one per Workspace this
    // connection owns. The sessions to close are read from the list as it is
    // now; the removal is not, because the list can change while they close.
    const beforeTeardown = workspaceStateRef.current;
    const owned = removeConnectionWorkspaces(
      beforeTeardown.workspaces,
      connection.id,
      beforeTeardown.activeWorkspaceId,
      beforeTeardown.terminalGroups,
    ).removed;
    for (const workspace of owned) {
      if (workspace.sessionId) await api.closeSession(workspace.sessionId).catch(() => undefined);
    }

    // Read again now that every teardown has finished. A Workspace opened, or
    // a session state that arrived, while they ran is in this list and in no
    // snapshot taken before them. Everything from here is synchronous, so this
    // is the list the writes below are derived from.
    const current = workspaceStateRef.current;
    const removal = removeConnectionWorkspaces(
      current.workspaces,
      connection.id,
      current.activeWorkspaceId,
      current.terminalGroups,
    );
    setWorkspaces(removal.remaining);
    setTerminalGroups(removal.nextGroups);
    setActiveWorkspaceId(removal.nextActiveId);
    if (!removal.nextActiveId) exitTerminalFocus();
  }

  function saveConnection(saved: SavedConnection) {
    const previous = connectionsRef.current.find((connection) => connection.id === saved.id);
    const targetChanged = previous && connectionTargetKey(previous) !== connectionTargetKey(saved);
    if (targetChanged) {
      connectionsRef.current = connectionsRef.current.map((connection) =>
        connection.id === saved.id ? saved : connection,
      );
      setHostCapabilities((current) => {
        const next = { ...current };
        delete next[saved.id];
        return next;
      });
    }
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
    if (targetChanged) detectConnectionCapabilities(saved.id);
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

  /// The Scratchpad popover's paste works on any terminal — local or remote —
  /// and follows the selected pane, so it takes the live workspace rather than
  /// the remote-only view the History paste is bound to. writeSession sends
  /// raw bytes with no trailing newline, so the note is typed, never run.
  function pasteNoteIntoTerminal(text: string) {
    if (!activeWorkspace?.sessionId) {
      setActionError("Reconnect the terminal before pasting a note.");
      return;
    }
    setActionError(null);
    void api
      .writeSession(activeWorkspace.sessionId, new TextEncoder().encode(text))
      .catch((caught) => setActionError(`Could not paste into terminal: ${errorMessage(caught)}`));
  }

  /// Keep shell and host identity consistent across tabs, menus, and split panes.
  function workspaceMark(workspace: Workspace) {
    return isLocalWorkspace(workspace) ? (
      <LocalShellIcon kind={workspace.shell.kind} elevated={workspace.shell.elevated} />
    ) : (
      <HostOsIcon
        osId={hostCapabilities[workspace.connectionId]?.osId}
        osName={hostCapabilities[workspace.connectionId]?.osName}
      />
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
        <button
          className="host-main"
          type="button"
          onClick={() => openConnection(connection)}
          aria-describedby={`connection-session-${connection.id}`}
        >
          <span className="target-mark">
            <HostOsIcon
              osId={hostCapabilities[connection.id]?.osId}
              osName={hostCapabilities[connection.id]?.osName}
            />
          </span>
          <span className="host-row-details">
            <strong>{connection.displayName}</strong>
            <small>{connectionTarget(connection)}</small>
          </span>
          <span className="host-session-status" title={connectionStatus(connection.id)}>
            {connectionSessionStates[connection.id] && (
              <span
                className={`presence presence-${connectionSessionStates[connection.id]}${processingConnections.has(connection.id) ? " presence-busy" : ""}`}
                aria-hidden="true"
              />
            )}
          </span>
          {!!connection.tags.length && (
            <span className="host-tag-summary">
              {connection.tags.map((tag) => (
                <span
                  className="connection-tag-badge"
                  style={tagBadgeStyle(tag.color)}
                  title={tag.name}
                  key={tag.id}
                >
                  {tag.name}
                </span>
              ))}
            </span>
          )}
        </button>
        <span className="sr-only" id={`connection-session-${connection.id}`}>
          {connectionStatus(connection.id)}
        </span>
        <button
          className="host-menu"
          type="button"
          onClick={(event) => {
            if (hostMenuConnectionId === connection.id) {
              setHostMenuConnectionId(null);
              setHostMenuPosition(null);
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            const width = 190;
            const height = 76;
            setHostMenuPosition({
              top:
                rect.bottom + height + 8 > window.innerHeight
                  ? rect.top - height - 4
                  : rect.bottom + 4,
              left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
            });
            setHostMenuConnectionId(connection.id);
          }}
          aria-label={`Open actions for ${connection.displayName}`}
          aria-haspopup="menu"
          aria-expanded={hostMenuConnectionId === connection.id}
        >
          <MoreHorizontal size={16} />
        </button>
        {hostMenuConnectionId === connection.id && (
          <div
            className="host-context-menu"
            role="menu"
            style={hostMenuPosition ?? undefined}
            data-app-popover=""
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setHostMenuConnectionId(null);
                setHostMenuPosition(null);
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
                setHostMenuPosition(null);
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

  /* Installing replaces this process, so the interruption is stated before it
     happens rather than after. Whether sessions are live is read from the
     Workspaces already in state; the updater adds no lifecycle tracker of its
     own to answer this. Saved Workspaces request fresh sessions after restart. */
  function requestUpdateInstall() {
    const version = updateInfo(updater.state)?.version ?? "the new version";
    const live = workspaces.some((workspace) => workspace.sessionId);
    setConfirmState({
      title: "Install update?",
      message: live
        ? `Control Room will close and reopen to install v${version}. Active terminal sessions and log streams will end.`
        : `Control Room will close and reopen to install v${version}.`,
      confirmLabel: "Restart and update",
      onConfirm: () => void updater.install(),
    });
  }

  function renderWorkspaceTab(workspace: Workspace, grouped = false) {
    return (
      <div
        className={[
          "session-tab-wrap",
          workspace.id === activeWorkspaceId && !settingsOpen ? "active" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-session-state={workspace.state}
        key={workspace.id}
      >
        <button
          className="session-tab-main"
          type="button"
          title={duplicateLabel(workspace)}
          aria-current={workspace.id === activeWorkspaceId && !settingsOpen ? "page" : undefined}
          aria-describedby={`workspace-session-${workspace.id}`}
          onClick={() => selectWorkspaceTab(workspace)}
        >
          <span className="target-mark">{workspaceMark(workspace)}</span>
          <span className="session-tab-label">{duplicateLabel(workspace)}</span>
          {(workspace.state !== "connected" ||
            terminalFocusMode ||
            workspaceProcessing(workspace)) && (
            <span
              className={`presence presence-${workspace.state}${workspaceProcessing(workspace) ? " presence-busy" : ""}`}
              aria-hidden="true"
              title={`Terminal ${workspaceStatus(workspace)}`}
            />
          )}
          {terminalActivity[workspace.id] && (
            <span
              className={`terminal-activity terminal-activity-${terminalActivity[workspace.id]}`}
              aria-label={
                terminalActivity[workspace.id] === "bell" ? "Terminal bell" : "New terminal output"
              }
              title={
                terminalActivity[workspace.id] === "bell" ? "Terminal bell" : "New terminal output"
              }
            />
          )}
        </button>
        <span className="sr-only" id={`workspace-session-${workspace.id}`}>
          Terminal {workspaceStatus(workspace)}
        </span>
        <button
          className="session-tab-rename"
          type="button"
          onClick={() => renameWorkspace(workspace)}
          aria-label={`Rename ${duplicateLabel(workspace)} Workspace`}
          title={grouped ? `Rename terminal: ${duplicateLabel(workspace)}` : "Rename Workspace"}
        >
          <Pencil size={12} />
        </button>
        <button
          className="session-tab-close"
          type="button"
          onClick={() => void closeWorkspace(workspace.id)}
          aria-label={`Close ${duplicateLabel(workspace)} Workspace`}
          title={`Close terminal: ${duplicateLabel(workspace)}`}
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  async function openDocumentation() {
    if (openingDocumentationRef.current) return;
    openingDocumentationRef.current = true;
    setOpeningDocumentation(true);
    setDocumentationError(null);
    try {
      await api.openDocumentation();
    } catch (error) {
      setDocumentationError(`Could not open documentation: ${errorMessage(error)}`);
    } finally {
      openingDocumentationRef.current = false;
      setOpeningDocumentation(false);
    }
  }

  function renderDocumentationButton(className: string) {
    return (
      <button
        className={className}
        type="button"
        onClick={() => void openDocumentation()}
        disabled={openingDocumentation}
        aria-label="Open documentation"
        aria-busy={openingDocumentation}
        title={
          openingDocumentation ? "Opening documentation…" : "Documentation (opens in your browser)"
        }
      >
        <BookOpen size={18} />
      </button>
    );
  }

  if (loading) return <LoadingState label="Starting Control Room…" />;
  if (!settingsContract) return <ErrorState message={bootError ?? "Could not load Settings."} />;
  const settings = settingsContract.current;
  const listedGroups = new Set<string>();
  const workspaceTabOptions = workspaces.flatMap((workspace) => {
    const group = terminalFocusMode
      ? terminalGroupForWorkspace(terminalGroups, workspace.id)
      : null;
    if (group) {
      if (listedGroups.has(group.id)) return [];
      listedGroups.add(group.id);
      return [
        {
          id: group.id,
          label: group.name,
          icon: <Columns2 size={17} strokeWidth={1.8} />,
          detail: `${getTerminalLayoutIds(group.layout).length} terminals`,
          active: activeTerminalGroup?.id === group.id && !settingsOpen,
          onSelect: () => selectTerminalGroup(group),
        },
      ];
    }
    return [
      {
        id: workspace.id,
        label: duplicateLabel(workspace),
        icon: workspaceMark(workspace),
        detail: terminalStateLabel(workspace),
        active: workspace.id === activeWorkspaceId && !settingsOpen,
        onSelect: () => selectWorkspaceTab(workspace),
      },
    ];
  });

  const headerMetrics = displayedHeaderMetrics(settingsContract?.current.hostMetrics);
  const focusToggleAvailable = !settingsOpen && activeWorkspace?.view === "terminal";
  return (
    <div
      ref={shellSize.ref}
      data-focus-toggle={focusToggleAvailable ? "visible" : "hidden"}
      className={
        settingsOpen
          ? "app-shell settings-mode"
          : terminalFocusMode
            ? "app-shell terminal-focus-mode"
            : "app-shell"
      }
      style={
        !terminalFocusMode && !settingsOpen
          ? { gridTemplateColumns: `${railWidth}px minmax(0, 1fr)` }
          : undefined
      }
    >
      <header className="app-bar" data-tauri-drag-region>
        {!settingsOpen &&
          !terminalFocusMode &&
          settingsContract?.current.hostMetricsEnabled &&
          activeWorkspace &&
          headerMetrics.length > 0 && (
            <HostMetrics
              key={
                isLocalWorkspace(activeWorkspace)
                  ? "local"
                  : `${activeWorkspace.connectionId}:${activeWorkspace.connectionSnapshot.updatedAt}`
              }
              target={isLocalWorkspace(activeWorkspace) ? "local" : activeWorkspace.connectionId}
              name={
                isLocalWorkspace(activeWorkspace)
                  ? "Local machine"
                  : activeWorkspace.connectionSnapshot.displayName
              }
              metrics={headerMetrics}
              seconds={settingsContract.current.hostMetricsIntervalSeconds ?? 5}
              onSettings={() => setSettingsOpen(true)}
            />
          )}
        <div className="app-bar-actions">
          {!settingsOpen && (
            <UpdateIndicator
              state={updater.state}
              onDownload={() => void updater.download()}
              onRestart={requestUpdateInstall}
            />
          )}
          {(!terminalFocusMode || settingsOpen) && renderDocumentationButton("app-bar-button")}
          {!settingsOpen && (
            <button
              className="app-bar-button"
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Open Settings"
              title="Settings"
            >
              <Settings size={18} />
            </button>
          )}
        </div>
      </header>

      <div className="app-window-actions" role="group" aria-label="Window actions">
        <button
          className="app-bar-button app-focus-toggle"
          type="button"
          inert={!focusToggleAvailable}
          aria-hidden={!focusToggleAvailable}
          disabled={!focusToggleAvailable}
          onClick={terminalFocusMode ? exitTerminalFocus : enterTerminalFocus}
          aria-label={terminalFocusMode ? "Exit terminal focus" : "Focus terminal"}
          aria-pressed={terminalFocusMode}
          title={terminalFocusMode ? "Exit terminal focus" : "Focus terminal"}
        >
          {terminalFocusMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <WindowControls />
      </div>

      <aside className={activeRemoteWorkspace ? "sidebar workspace-open" : "sidebar"}>
        <div className="sidebar-heading sidebar-top-heading" data-tauri-drag-region>
          <span data-tauri-drag-region>Connections</span>
          <span data-tauri-drag-region>{connections.length}</span>
          <button
            type="button"
            className="icon-button layout-reset"
            aria-label="Reset layout"
            title="Reset all panel sizes"
            onClick={() => setPanelSizes({})}
          >
            <RotateCcw size={14} />
          </button>
        </div>
        <div className="sidebar-filter-row">
          <label className="search-field sidebar-search">
            <Search size={14} />
            <input
              value={hostSearch}
              onChange={(event) => setHostSearch(event.target.value)}
              placeholder="Find a connection"
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
        <SidebarSections
          layout={panelLayout}
          hosts={
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
                      <ChevronDown size={13} />
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
          }
          capabilities={
            activeRemoteWorkspace && (
              <div className="workspace-navigation">
                <nav className="feature-nav" aria-label="Workspace features">
                  {offeredNavigation.map(({ id, label, icon: Icon }) => (
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
            )
          }
        />
        <div className="sidebar-footer">
          <button
            className="sidebar-primary"
            type="button"
            onClick={() => setDialogConnection("new")}
          >
            <Plus size={16} />
            <span className="sidebar-action-label">Add connection</span>
          </button>
        </div>
        <ResizeDivider
          label="Resize Connections panel"
          value={railWidth}
          min={PANEL_LIMITS.connections.min}
          max={railMax}
          className="connections-divider"
          onChange={(next) => setPanelSize("connections", next)}
          onReset={() => setPanelSize("connections", null)}
        />
      </aside>

      <main className="workspace-shell">
        {(workspaces.length > 0 || canOpenNewTerminal) && (
          <nav className="session-tabs" aria-label="Open Workspaces">
            <WorkspaceTabScroller
              activeTabId={settingsOpen ? null : activeWorkspaceId}
              arrangementKey={tabArrangementKey}
              items={workspaceTabOptions}
            >
              {terminalFocusMode
                ? (() => {
                    const renderedGroups = new Set<string>();
                    return workspaces.flatMap((workspace) => {
                      const group = terminalGroupForWorkspace(terminalGroups, workspace.id);
                      if (!group) return [renderWorkspaceTab(workspace)];
                      if (renderedGroups.has(group.id)) return [];
                      renderedGroups.add(group.id);
                      const members = getTerminalLayoutIds(group.layout).flatMap((workspaceId) => {
                        const workspace = workspaces.find((item) => item.id === workspaceId);
                        return workspace ? [workspace] : [];
                      });
                      const active = activeTerminalGroup?.id === group.id;
                      const state = members.some((member) => member.state === "error")
                        ? "error"
                        : members.some((member) => member.state === "connecting")
                          ? "connecting"
                          : members.some((member) => member.state === "disconnected")
                            ? "disconnected"
                            : "connected";
                      const activity = members.some(
                        (member) => terminalActivity[member.id] === "bell",
                      )
                        ? "bell"
                        : members.some((member) => terminalActivity[member.id])
                          ? "output"
                          : null;
                      return (
                        <div
                          className={active ? "session-tab-group active" : "session-tab-group"}
                          role="group"
                          aria-label={group.name}
                          key={group.id}
                        >
                          <span className="session-tab-group-label">
                            <button
                              className="session-tab-group-main"
                              type="button"
                              onClick={() => selectTerminalGroup(group)}
                              aria-current={active ? "page" : undefined}
                              aria-label={`Open ${group.name} ${members.length} ${members.length === 1 ? "terminal" : "terminals"}`}
                              aria-describedby={`terminal-group-status-${group.id}`}
                              title={`${group.name}: ${members.map(duplicateLabel).join(", ")}`}
                            >
                              <Columns2 size={13} strokeWidth={1.8} aria-hidden="true" />
                              <span>{group.name}</span> <small>{members.length}</small>
                              <span
                                className={`presence presence-${state}${members.some(workspaceProcessing) ? " presence-busy" : ""}`}
                                aria-hidden="true"
                              />
                              {activity && (
                                <span
                                  className={`terminal-activity terminal-activity-${activity}`}
                                  aria-label={
                                    activity === "bell" ? "Terminal bell" : "New terminal output"
                                  }
                                />
                              )}
                            </button>
                          </span>
                          <span className="sr-only" id={`terminal-group-status-${group.id}`}>
                            {members
                              .map(
                                (member) =>
                                  `${duplicateLabel(member)}: ${workspaceStatus(member)}${terminalActivity[member.id] === "bell" ? ", terminal bell" : terminalActivity[member.id] ? ", new output" : ""}`,
                              )
                              .join("; ")}
                          </span>
                        </div>
                      );
                    });
                  })()
                : workspaces.map((workspace) => renderWorkspaceTab(workspace))}
            </WorkspaceTabScroller>
            <span className="session-new-terminal-anchor" data-new-terminal-menu>
              <button
                ref={newTerminalButtonRef}
                className={
                  workspaces.length
                    ? "session-new-terminal"
                    : "session-new-terminal session-new-terminal-empty"
                }
                type="button"
                onClick={openNewTerminalMenu}
                disabled={!canOpenNewTerminal}
                aria-haspopup="dialog"
                aria-label="New terminal"
                aria-expanded={newTerminalMenuOpen}
                title="Open a terminal for a Saved Connection or a local shell"
              >
                <Plus size={16} />
                {!workspaces.length && <span>New terminal</span>}
                <ChevronDown size={12} />
              </button>
              {newTerminalMenuPresent && (
                <TerminalTargetMenu
                  label="New terminal"
                  className="new-terminal-menu"
                  groups={newTerminalGroups}
                  style={newTerminalMenuAt ?? undefined}
                  closing={newTerminalMenuClosing}
                  footer={
                    administratorGroupOffered &&
                    !administratorLocalShells.length && (
                      <details className="terminal-administrator-setup">
                        <summary>
                          <ShieldAlert size={14} />
                          Run as administrator
                          <ChevronDown size={12} />
                        </summary>
                        <p>{administratorTerminalNote(administratorTerminalStatus)}</p>
                      </details>
                    )
                  }
                  onClose={() => {
                    setNewTerminalMenuOpen(false);
                    newTerminalButtonRef.current?.focus();
                  }}
                />
              )}
            </span>
            {terminalFocusMode && (
              <div
                className="session-window-drag-region"
                data-tauri-drag-region
                title="Drag to move window"
                aria-hidden="true"
              />
            )}
            {!settingsOpen && activeWorkspace?.view === "terminal" && (
              <div className="session-tab-actions" data-terminal-split-menu>
                <div
                  className="session-terminal-actions"
                  role="group"
                  aria-label="Terminal actions"
                >
                  <button
                    className="session-strip-button"
                    type="button"
                    onClick={() =>
                      setTerminalFindRequests((current) => ({
                        ...current,
                        [activeWorkspace.id]: (current[activeWorkspace.id] ?? 0) + 1,
                      }))
                    }
                    aria-label="Find in terminal"
                    title="Find in terminal"
                  >
                    <Search size={15} />
                  </button>
                  <button
                    className="session-strip-button"
                    type="button"
                    onClick={() =>
                      terminalHandlesRef.current.get(activeWorkspace.id)?.copySelection()
                    }
                    disabled={!terminalHasSelection[activeWorkspace.id]}
                    aria-label="Copy terminal selection"
                    title="Copy selection"
                  >
                    <Copy size={15} />
                  </button>
                  <button
                    className="session-strip-button"
                    type="button"
                    onClick={() =>
                      terminalHandlesRef.current.get(activeWorkspace.id)?.pasteClipboard()
                    }
                    disabled={activeTerminalEnded}
                    aria-label="Paste into terminal"
                    title="Paste"
                  >
                    <Clipboard size={15} />
                  </button>
                  <button
                    ref={scratchpadButtonRef}
                    className="session-strip-button"
                    type="button"
                    data-scratchpad-trigger
                    onClick={() => setScratchpadOpen((open) => !open)}
                    aria-label="Scratchpad"
                    title="Scratchpad"
                    aria-haspopup="dialog"
                    aria-expanded={scratchpadOpen}
                  >
                    <StickyNote size={15} />
                  </button>
                </div>
                {scratchpadPresent && activeWorkspace?.view === "terminal" && (
                  <TerminalScratchpad
                    style={scratchpadAt ?? undefined}
                    terminalScope={isLocalWorkspace(activeWorkspace) ? "local" : "connection"}
                    ownerId={
                      isLocalWorkspace(activeWorkspace)
                        ? activeWorkspace.id
                        : activeWorkspace.connectionId
                    }
                    ownerLabel={
                      isLocalWorkspace(activeWorkspace)
                        ? (activeWorkspace.label ?? activeWorkspace.shell.label)
                        : activeWorkspace.connectionSnapshot.displayName
                    }
                    canPaste={Boolean(activeWorkspace.sessionId) && !activeTerminalEnded}
                    onPaste={pasteNoteIntoTerminal}
                    closing={scratchpadClosing}
                    onClose={() => {
                      setScratchpadOpen(false);
                      scratchpadButtonRef.current?.focus();
                    }}
                  />
                )}
                {terminalFocusMode && (
                  <>
                    <button
                      ref={splitMenuButtonRef}
                      className="session-strip-button"
                      type="button"
                      onClick={openSplitMenu}
                      disabled={
                        !connections.length &&
                        !existingSplitCandidates.length &&
                        !offeredShells.length
                      }
                      aria-label="Split terminal"
                      aria-haspopup="dialog"
                      aria-expanded={splitMenuOpen}
                      title={
                        activeTerminalGroup
                          ? "Add a terminal to this group"
                          : "Create a group with another terminal"
                      }
                    >
                      <Columns2 size={15} />
                    </button>
                    {splitMenuPresent && (
                      <TerminalTargetMenu
                        label="Split terminal"
                        className="terminal-split-menu"
                        groups={splitTargetGroups}
                        style={splitMenuAt ?? undefined}
                        closing={splitMenuClosing}
                        onClose={() => {
                          setSplitMenuOpen(false);
                          splitMenuButtonRef.current?.focus();
                        }}
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
                      </TerminalTargetMenu>
                    )}
                  </>
                )}
              </div>
            )}
          </nav>
        )}
        {terminalFocusMode && activeTerminalGroup && !settingsOpen && (
          <nav
            className="session-pane-tabs"
            aria-label={`Terminals in ${activeTerminalGroup.name}`}
          >
            <span className="session-pane-heading">Panes</span>
            <WorkspaceTabScroller
              activeTabId={activeWorkspaceId}
              arrangementKey={tabArrangementKey}
              menuLabel="All panes"
              items={getTerminalLayoutIds(activeTerminalGroup.layout).flatMap((id) => {
                const workspace = workspaces.find((item) => item.id === id);
                return workspace
                  ? [
                      {
                        id,
                        label: duplicateLabel(workspace),
                        icon: workspaceMark(workspace),
                        detail: terminalStateLabel(workspace),
                        active: id === activeWorkspaceId,
                        onSelect: () => selectWorkspaceTab(workspace),
                      },
                    ]
                  : [];
              })}
            >
              {getTerminalLayoutIds(activeTerminalGroup.layout).flatMap((id) => {
                const workspace = workspaces.find((item) => item.id === id);
                return workspace ? [renderWorkspaceTab(workspace, true)] : [];
              })}
            </WorkspaceTabScroller>
            <button
              className="session-group-action"
              type="button"
              onClick={() => setRenameGroupTarget(activeTerminalGroup)}
              aria-label={`Rename group ${activeTerminalGroup.name}`}
              title="Rename terminal group"
            >
              <Pencil size={14} />
              Rename group
            </button>
            <button
              className="session-group-action"
              type="button"
              onClick={() => confirmUngroup(activeTerminalGroup)}
              aria-label={`Ungroup ${activeTerminalGroup.name}; terminals stay open`}
              title="Ungroup terminals; keep every terminal open"
            >
              Ungroup
            </button>
          </nav>
        )}

        {documentationError && (
          <div className="inline-error app-action-error" role="alert">
            <span>{documentationError}</span>
            <button
              type="button"
              onClick={() => setDocumentationError(null)}
              aria-label="Dismiss documentation error"
            >
              <X size={14} />
            </button>
          </div>
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
              ref={terminalLayoutViewportRef}
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
                  const paneRect = terminalPaneRects[workspace.id];
                  const panePixels =
                    paneRect && getTerminalPanePixels(paneRect, terminalLayoutViewport);
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
                          ? (panePixels ?? {
                              left: `${paneRect.left}%`,
                              top: `${paneRect.top}%`,
                              width: `${paneRect.width}%`,
                              height: `${paneRect.height}%`,
                            })
                          : undefined
                      }
                    >
                      <TerminalPane
                        ref={(handle) => {
                          if (handle) terminalHandlesRef.current.set(workspace.id, handle);
                          else terminalHandlesRef.current.delete(workspace.id);
                        }}
                        workspace={workspace}
                        settings={settings}
                        visible={terminalVisible}
                        active={terminalVisible && workspace.id === activeWorkspace.id}
                        onActivate={() => {
                          const group = terminalGroupForWorkspace(terminalGroups, workspace.id);
                          if (group) {
                            terminalGroupActiveWorkspaceRef.current.set(group.id, workspace.id);
                          }
                          setActiveWorkspaceId(workspace.id);
                        }}
                        onSession={(sessionId) => updateWorkspace(workspace.id, { sessionId })}
                        onState={(state, reason) => {
                          updateWorkspace(workspace.id, {
                            state,
                            reason,
                            restored: false,
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
                        onSelectionChange={(hasSelection) =>
                          setTerminalHasSelection((current) =>
                            current[workspace.id] === hasSelection
                              ? current
                              : { ...current, [workspace.id]: hasSelection },
                          )
                        }
                        onActivity={(kind) =>
                          setTerminalActivity((current) => ({
                            ...current,
                            [workspace.id]:
                              kind === "bell" || current[workspace.id] !== "bell"
                                ? kind
                                : current[workspace.id],
                          }))
                        }
                        onProcessing={(busy) =>
                          setTerminalProcessing((current) => {
                            if (!!current[workspace.id] === busy) return current;
                            const next = { ...current };
                            if (busy) next[workspace.id] = true;
                            else delete next[workspace.id];
                            return next;
                          })
                        }
                        findRequest={terminalFindRequests[workspace.id] ?? 0}
                        onReconnect={() =>
                          updateWorkspace(workspace.id, {
                            connectRequested: true,
                            restored: false,
                            reconnectToken: workspace.reconnectToken + 1,
                          })
                        }
                      />
                    </div>
                  );
                })}
              </Suspense>
              {!settingsOpen &&
                activeTerminalGroup &&
                terminalGeometry.dividers.map((divider, index) => {
                  const vertical = divider.direction === "vertical";
                  const { rectangle } = divider;
                  const changeRatio = (ratio: number) =>
                    setTerminalGroups((groups) =>
                      groups.map((group) =>
                        group.id === activeTerminalGroup.id
                          ? {
                              ...group,
                              layout: resizeTerminalLayout(group.layout, divider.path, ratio),
                            }
                          : group,
                      ),
                    );
                  return (
                    <ResizeDivider
                      key={`${activeTerminalGroup.id}:${divider.path}:${divider.direction}`}
                      label={`Resize terminal split ${index + 1}`}
                      orientation={vertical ? "vertical" : "horizontal"}
                      value={divider.position}
                      min={divider.min}
                      max={divider.max}
                      className="terminal-layout-divider"
                      style={
                        vertical
                          ? {
                              left: `${rectangle.left + (rectangle.width * divider.position) / divider.size}%`,
                              top: `${rectangle.top}%`,
                              height: `${rectangle.height}%`,
                            }
                          : {
                              top: `${rectangle.top + (rectangle.height * divider.position) / divider.size}%`,
                              left: `${rectangle.left}%`,
                              width: `${rectangle.width}%`,
                            }
                      }
                      onChange={(size) => changeRatio(size / divider.size)}
                      onReset={() => changeRatio(0.5)}
                    />
                  );
                })}
              {/* Inspection views need a Remote Host and its Saved
                  Connection. A local Workspace renders its terminal only. */}
              {activeRemoteWorkspace && activeConnection && activeSavedConnection && (
                <ConnectionSection
                  key={connectionTargetKey(activeConnection)}
                  section={activeRemoteWorkspace.view}
                  layout={panelLayout}
                >
                  {activeRemoteWorkspace.view === "services" &&
                    (windowsWorkspace ? (
                      <Suspense fallback={<LoadingState label="Loading Windows services..." />}>
                        <WindowsServicesPane
                          key={activeRemoteWorkspace.id}
                          connection={activeConnection}
                        />
                      </Suspense>
                    ) : (
                      <ServicesPane
                        key={activeRemoteWorkspace.id}
                        connection={activeConnection}
                        cache={activeRemoteWorkspace.servicesCache}
                        onCacheChange={(cache) =>
                          updateServicesCache(activeRemoteWorkspace.id, cache)
                        }
                        onViewLogs={(source) => openLogs(activeRemoteWorkspace.id, source)}
                        focusId={activeRemoteWorkspace.systemdSelectionId}
                        initialState={activeRemoteWorkspace.systemdExplorer}
                        onStateChange={(systemdExplorer) =>
                          updateRemoteWorkspace(activeRemoteWorkspace.id, { systemdExplorer })
                        }
                        onSelectionChange={(systemdSelectionId) =>
                          updateRemoteWorkspace(activeRemoteWorkspace.id, { systemdSelectionId })
                        }
                        onOpenPorts={(unit) => {
                          setSystemdPortFocus({ workspaceId: activeRemoteWorkspace.id, unit });
                          updateRemoteWorkspace(activeRemoteWorkspace.id, { view: "ports" });
                        }}
                        onOpenBoot={() =>
                          updateRemoteWorkspace(activeRemoteWorkspace.id, { view: "boot" })
                        }
                      />
                    ))}
                  {activeRemoteWorkspace.view === "ports" && (
                    <PortsPane
                      focusUnit={
                        systemdPortFocus?.workspaceId === activeRemoteWorkspace.id
                          ? systemdPortFocus.unit
                          : undefined
                      }
                      focusEndpoint={
                        portFocus?.workspaceId === activeRemoteWorkspace.id ? portFocus : undefined
                      }
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
                      onOpenSystemd={(unit) => openSystemd(activeRemoteWorkspace.id, unit)}
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
                      onOpenPort={(endpoint) => {
                        setPortFocus({ ...endpoint, workspaceId: activeRemoteWorkspace.id });
                        updateRemoteWorkspace(activeRemoteWorkspace.id, { view: "ports" });
                      }}
                      key={activeRemoteWorkspace.id}
                      connection={activeConnection}
                      windowsHost={windowsWorkspace}
                      cache={activeRemoteWorkspace.containersCache}
                      capabilities={hostCapabilities[activeConnection.id] ?? null}
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
                      onOpenSystemd={(unit) => openSystemd(activeRemoteWorkspace.id, unit)}
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
                      windowsHost={windowsWorkspace}
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
                </ConnectionSection>
              )}
            </div>
          </section>
        )}

        {settingsOpen ? (
          <SettingsPane
            settings={settings}
            defaults={settingsContract.defaults}
            logTailOptions={settingsContract.logTailOptions}
            localShells={localShells}
            environment={environment}
            appVersion={updater.currentVersion}
            onCheckForUpdates={updater.checkNow}
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
            </p>
            {!connections.length && (
              <p className="empty-workspace-note">
                The connection editor can test read-only inspection access before you save.
              </p>
            )}
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
      {remoteShellRequest && (
        <RemoteShellDialog
          connection={remoteShellRequest.connection}
          onCapabilities={rememberCapabilities}
          onClose={() => setRemoteShellRequest(null)}
          onSelect={selectRemoteShell}
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

      {renameGroupTarget && (
        <PromptDialog
          title="Rename terminal group"
          label="Group name"
          description="This name appears in the Workspace tab strip."
          defaultValue={renameGroupTarget.name}
          placeholder="Terminal group"
          submitLabel="Rename"
          onSubmit={(value) => {
            setTerminalGroups((current) =>
              renameTerminalGroup(current, renameGroupTarget.id, value),
            );
            setRenameGroupTarget(null);
          }}
          onClose={() => setRenameGroupTarget(null)}
        />
      )}

      {updater.notice && (
        <WhatsNewDialog notice={updater.notice} onDismiss={updater.dismissNotice} />
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
          localShells={offeredShells}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          activeView={activeWorkspace?.view ?? null}
          canOpenNewTerminal={canOpenNewTerminal}
          activeWorkspaceIsLocal={Boolean(activeWorkspace && isLocalWorkspace(activeWorkspace))}
          canFocusTerminal={Boolean(activeWorkspace && activeWorkspace.view === "terminal")}
          canSplitTerminal={canSplitTerminal}
          // A local Workspace offers only Terminal; remote
          // Workspaces offer the inspection views their platform supports.
          views={activeWorkspace ? offeredNavigation : []}
          hostCapabilities={hostCapabilities}
          labelForWorkspace={duplicateLabel}
          onClose={() => setPaletteOpen(false)}
          onOpenConnection={(connection) => openConnection(connection)}
          onOpenLocalShell={openLocalShell}
          onSelectWorkspace={(workspace) => selectWorkspaceTab(workspace)}
          onSetView={(view) => {
            if (!activeWorkspace) return;
            closeSettings(() => updateWorkspace(activeWorkspace.id, { view }));
          }}
          onNewTerminal={openNewTerminalMenu}
          onReconnect={() =>
            activeWorkspace &&
            updateWorkspace(activeWorkspace.id, {
              connectRequested: true,
              restored: false,
              reconnectToken: activeWorkspace.reconnectToken + 1,
            })
          }
          onCloseWorkspace={() => activeWorkspace && void closeWorkspace(activeWorkspace.id)}
          onFocusTerminal={enterTerminalFocus}
          onFindTerminal={() => {
            if (!activeWorkspace) return;
            setTerminalFindRequests((current) => ({
              ...current,
              [activeWorkspace.id]: (current[activeWorkspace.id] ?? 0) + 1,
            }));
          }}
          onSplitTerminal={() => {
            enterTerminalFocus();
            setSplitMenuOpen(true);
          }}
          onOpenScratchpad={openScratchpad}
          onRenameWorkspace={() => activeWorkspace && renameWorkspace(activeWorkspace)}
          onManageConnections={() => setConnectionGroupsOpen(true)}
          onAddConnection={() => setDialogConnection("new")}
          onOpenSettings={() => setSettingsOpen(true)}
          onCheckForUpdates={() => void updater.checkNow()}
        />
      )}
    </div>
  );
}
