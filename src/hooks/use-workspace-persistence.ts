import { useEffect, useMemo } from "react";
import { api, errorMessage } from "../lib/api";
import type { TerminalLayout } from "../lib/terminal-layout";
import { persistWorkspaceState } from "../lib/workspace-persistence";
import type { Workspace } from "../types";

export function useWorkspacePersistence({
  ready,
  workspaces,
  activeWorkspaceId,
  terminalLayout,
  onError,
}: {
  ready: boolean;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  terminalLayout: TerminalLayout | null;
  onError: (message: string) => void;
}) {
  const state = useMemo(
    () => persistWorkspaceState(workspaces, activeWorkspaceId, terminalLayout),
    [activeWorkspaceId, terminalLayout, workspaces],
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
