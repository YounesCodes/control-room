import { useEffect, useMemo } from "react";
import { api, errorMessage } from "../lib/api";
import type { TerminalGroup } from "../lib/terminal-groups";
import { persistWorkspaceState } from "../lib/workspace-persistence";
import type { Workspace } from "../types";

export function useWorkspacePersistence({
  ready,
  workspaces,
  activeWorkspaceId,
  terminalGroups,
  onError,
}: {
  ready: boolean;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  terminalGroups: TerminalGroup[];
  onError: (message: string) => void;
}) {
  const state = useMemo(
    () => persistWorkspaceState(workspaces, activeWorkspaceId, terminalGroups),
    [activeWorkspaceId, terminalGroups, workspaces],
  );
  const serializedState = JSON.stringify(state);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      void api
        .saveWorkspaceState(state)
        .catch((caught) => onError(`Could not save Workspace layout: ${errorMessage(caught)}`));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [onError, ready, serializedState, state]);
}
