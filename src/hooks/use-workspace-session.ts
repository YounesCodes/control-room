import { useCallback, useMemo, useRef, useState } from "react";
import { transitionFocusMode } from "../lib/focus-mode-transition";
import type { TerminalGroup } from "../lib/terminal-groups";
import {
  emptyWorkspaceSession,
  settleWorkspaceSession,
  type WorkspaceSession,
} from "../lib/workspace-session";
import type { Workspace } from "../types";

export type WorkspaceSessionChange = (current: WorkspaceSession) => WorkspaceSession;

export interface WorkspaceSessionControls {
  current: () => WorkspaceSession;
  commit: (change: WorkspaceSessionChange) => void;
  restore: (session: WorkspaceSession) => void;
  setWorkspaces: (change: (current: Workspace[]) => Workspace[]) => void;
  setActiveWorkspaceId: (id: string | null) => void;
  setTerminalGroups: (change: (current: TerminalGroup[]) => TerminalGroup[]) => void;
  setTerminalFocusMode: (enabled: boolean) => void;
}

export function useWorkspaceSession(
  onFocusModeChange: () => void,
): [WorkspaceSession, WorkspaceSessionControls] {
  const [session, setSession] = useState(emptyWorkspaceSession);
  const latest = useRef(session);
  const focusModeChanged = useRef(onFocusModeChange);
  focusModeChanged.current = onFocusModeChange;

  const commit = useCallback((change: WorkspaceSessionChange) => {
    const previous = latest.current;
    const next = settleWorkspaceSession(change(previous));
    if (next === previous) return;
    latest.current = next;
    if (next.terminalFocusMode === previous.terminalFocusMode) {
      setSession(next);
      return;
    }
    transitionFocusMode(next.terminalFocusMode ? "enter" : "exit", () => {
      focusModeChanged.current();
      setSession(next);
    });
  }, []);

  const controls = useMemo<WorkspaceSessionControls>(
    () => ({
      current: () => latest.current,
      commit,
      restore(restored) {
        latest.current = settleWorkspaceSession(restored);
        setSession(latest.current);
      },
      setWorkspaces: (change) =>
        commit((current) => {
          const workspaces = change(current.workspaces);
          return workspaces === current.workspaces ? current : { ...current, workspaces };
        }),
      setActiveWorkspaceId: (activeWorkspaceId) =>
        commit((current) =>
          current.activeWorkspaceId === activeWorkspaceId
            ? current
            : { ...current, activeWorkspaceId },
        ),
      setTerminalGroups: (change) =>
        commit((current) => {
          const terminalGroups = change(current.terminalGroups);
          return terminalGroups === current.terminalGroups
            ? current
            : { ...current, terminalGroups };
        }),
      setTerminalFocusMode: (terminalFocusMode) =>
        commit((current) =>
          current.terminalFocusMode === terminalFocusMode
            ? current
            : { ...current, terminalFocusMode },
        ),
    }),
    [commit],
  );

  return [session, controls];
}
