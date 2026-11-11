import { useEffect, useMemo } from "react";
import { api, errorMessage } from "../lib/api";
import type { TerminalGroup } from "../lib/terminal-groups";
import { persistWorkspaceState } from "../lib/workspace-persistence";
import type { PersistedWorkspaceState, Workspace } from "../types";

export function useWorkspacePersistence({
  ready,
  workspaces,
  activeWorkspaceId,
  terminalGroups,
  panelSizes,
  onError,
}: {
  ready: boolean;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  terminalGroups: TerminalGroup[];
  panelSizes: import("../lib/panel-layout").PanelSizes;
  onError: (message: string) => void;
}) {
  // Workspaces change identity for session states, inspection caches, and other
  // things that are never saved. Only a change in what is saved is written.
  const serializedState = useMemo(
    () =>
      JSON.stringify(
        persistWorkspaceState(workspaces, activeWorkspaceId, terminalGroups, panelSizes),
      ),
    [activeWorkspaceId, terminalGroups, workspaces, panelSizes],
  );

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      void api
        .saveWorkspaceState(JSON.parse(serializedState) as PersistedWorkspaceState)
        .catch((caught) => onError(`Could not save Workspace layout: ${errorMessage(caught)}`));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [onError, ready, serializedState]);
}
