import { useCallback, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  provisionalChoice,
  provisionalDiscovery,
  provisionalSessionState,
  startProvisional,
  type ProvisionalStep,
  type ProvisionalTerminal,
} from "../lib/provisional-terminal";
import type { ConnectionState, HostCapabilities, RemoteShellCatalog } from "../types";

export interface ProvisionalTerminalActions {
  capabilities: (capabilities: HostCapabilities) => void;
  choose: (workspaceId: string, discovery: Promise<RemoteShellCatalog>) => void;
  close: (workspaceId: string) => void;
}

/**
 * Tracks terminals opened to a host whose platform is not known yet. The
 * default shell starts at once while shell discovery runs beside it, and the
 * tab stays hidden until one of them shows what the host is.
 */
export function useProvisionalTerminals(actions: ProvisionalTerminalActions) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const [terminals, setTerminals] = useState<Record<string, ProvisionalTerminal>>({});
  const terminalsRef = useRef(terminals);
  const discoveries = useRef(new Map<string, Promise<RemoteShellCatalog>>());

  const apply = useCallback((workspaceId: string, step: ProvisionalStep) => {
    const next = { ...terminalsRef.current };
    if (step.kind === "keep" || step.kind === "choose") next[workspaceId] = step.next;
    else delete next[workspaceId];
    terminalsRef.current = next;
    setTerminals(next);
    const discovery = discoveries.current.get(workspaceId);
    if (step.kind === "reveal" || step.kind === "close") discoveries.current.delete(workspaceId);
    if (step.kind === "choose" && discovery) actionsRef.current.choose(workspaceId, discovery);
    if (step.kind === "close") actionsRef.current.close(workspaceId);
  }, []);

  const withTerminal = useCallback(
    (workspaceId: string, step: (current: ProvisionalTerminal) => ProvisionalStep) => {
      const current = terminalsRef.current[workspaceId];
      if (!current) return null;
      const next = step(current);
      apply(workspaceId, next);
      return next;
    },
    [apply],
  );

  const start = useCallback(
    (workspaceId: string, connectionId: string) => {
      const discovery = api.discoverRemoteShells(connectionId, false);
      discoveries.current.set(workspaceId, discovery);
      apply(workspaceId, { kind: "keep", next: startProvisional() });
      discovery.then(
        (catalog) => {
          if (catalog.capabilities) actionsRef.current.capabilities(catalog.capabilities);
          withTerminal(workspaceId, (current) => provisionalDiscovery(current, catalog));
        },
        () => withTerminal(workspaceId, (current) => provisionalDiscovery(current, null)),
      );
    },
    [apply, withTerminal],
  );

  return {
    start,
    concealed: (workspaceId: string) => !!terminals[workspaceId]?.concealed,
    sessionState: (workspaceId: string, state: ConnectionState) =>
      withTerminal(workspaceId, (current) => provisionalSessionState(current, state)),
    choice: (workspaceId: string, choice: "shell" | "default" | "cancel") =>
      withTerminal(workspaceId, (current) => provisionalChoice(current, choice)),
    forget: (workspaceId: string) => {
      if (!terminalsRef.current[workspaceId]) return;
      discoveries.current.delete(workspaceId);
      const next = { ...terminalsRef.current };
      delete next[workspaceId];
      terminalsRef.current = next;
      setTerminals(next);
    },
  };
}
