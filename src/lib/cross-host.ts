import type {
  CrossHostOperation,
  CrossHostResult,
  CrossHostState,
  SavedConnection,
} from "../types";

const STATE_LABELS: Record<CrossHostState, string> = {
  running: "Running",
  completed: "Read",
  failed: "Failed",
  unsupported: "Not supported",
  unreachable: "Unreachable",
  authenticationRequired: "Authentication required",
  permissionRequired: "Permission required",
  cancelled: "Cancelled",
};

export function stateLabel(state: CrossHostState): string {
  return STATE_LABELS[state] ?? state;
}

// Only a completed row carries values. Every other state is a distinct answer,
// never an empty row that could read as "nothing there".
export function isReadable(state: CrossHostState): boolean {
  return state === "completed";
}

export function validateParameter(
  operation: CrossHostOperation | null,
  value: string,
): string | null {
  if (!operation?.parameter) return null;
  const trimmed = value.trim();
  if (!trimmed) return `${operation.parameter.label} is required`;
  if (operation.parameter.kind === "port") {
    const port = Number(trimmed);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return "Enter a port between 1 and 65535";
    }
    return null;
  }
  if (!/^[A-Za-z0-9@_.:-]+$/.test(trimmed)) return "Enter one systemd unit id";
  if (!/\.(service|timer|mount|socket)$/.test(trimmed)) {
    return "Include the unit type, such as nginx.service";
  }
  return null;
}

export function canRun(
  operation: CrossHostOperation | null,
  parameter: string,
  targetIds: string[],
): boolean {
  return Boolean(operation) && !validateParameter(operation, parameter) && targetIds.length > 0;
}

// Columns come from the operation registry, not from whichever host answered
// first, so a failed host does not silently narrow the table.
export function resultColumns(operation: CrossHostOperation | null): string[] {
  return operation?.facts ?? [];
}

export function factValue(result: CrossHostResult, name: string): string | null {
  return result.facts.find((fact) => fact.name === name)?.value ?? null;
}

export function summarizeRun(results: CrossHostResult[]): string {
  const read = results.filter((result) => result.state === "completed").length;
  const running = results.filter((result) => result.state === "running").length;
  const other = results.length - read - running;
  const parts = [`${read} read`];
  if (running) parts.push(`${running} running`);
  if (other) parts.push(`${other} unavailable`);
  return parts.join(", ");
}

// Merges streamed rows by connection, so a running row is replaced by its final
// state rather than appended beside it.
export function mergeResult(
  results: CrossHostResult[],
  incoming: CrossHostResult,
): CrossHostResult[] {
  const index = results.findIndex((result) => result.connectionId === incoming.connectionId);
  if (index === -1) return [...results, incoming];
  const next = [...results];
  next[index] = incoming;
  return next;
}

export function targetSummary(connections: SavedConnection[]): string {
  if (connections.length === 1) return connections[0].displayName;
  return `${connections.length} Saved Connections`;
}
