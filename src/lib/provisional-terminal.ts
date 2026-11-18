import type { ConnectionState, RemoteShellCatalog } from "../types";

export type ProvisionalPhase = "detecting" | "choosing" | "replacing";

export interface ProvisionalTerminal {
  phase: ProvisionalPhase;
  concealed: boolean;
  shellConnected: boolean;
}

export type ProvisionalStep =
  | { kind: "keep"; next: ProvisionalTerminal }
  | { kind: "reveal" }
  | { kind: "choose"; next: ProvisionalTerminal }
  | { kind: "close" };

export const startProvisional = (): ProvisionalTerminal => ({
  phase: "detecting",
  concealed: true,
  shellConnected: false,
});

const ended = (state: ConnectionState) => state === "disconnected" || state === "error";

export function provisionalSessionState(
  current: ProvisionalTerminal,
  state: ConnectionState,
): ProvisionalStep {
  if (state === "connecting") return { kind: "keep", next: current };
  if (current.phase === "replacing") return { kind: "reveal" };
  if (state === "connected") {
    return { kind: "keep", next: { ...current, concealed: false, shellConnected: true } };
  }
  if (!ended(state)) return { kind: "keep", next: current };
  const next = { ...current, shellConnected: false };
  if (current.phase === "choosing" || !current.concealed) return { kind: "keep", next };
  return { kind: "choose", next: { ...next, phase: "choosing" } };
}

export function provisionalDiscovery(
  current: ProvisionalTerminal,
  catalog: RemoteShellCatalog | null,
): ProvisionalStep {
  if (current.phase !== "detecting") return { kind: "keep", next: current };
  if (!catalog || catalog.platform === "linux") return { kind: "reveal" };
  return { kind: "choose", next: { ...current, phase: "choosing" } };
}

export function provisionalChoice(
  current: ProvisionalTerminal,
  choice: "shell" | "default" | "cancel",
): ProvisionalStep {
  if (choice === "cancel") return current.shellConnected ? { kind: "reveal" } : { kind: "close" };
  if (choice === "default" && current.shellConnected) return { kind: "reveal" };
  return { kind: "keep", next: { ...current, phase: "replacing", concealed: true } };
}
