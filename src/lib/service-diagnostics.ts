import type {
  DiagnosticSectionKind,
  ListenerEvidence,
  ServiceDiagnosticSection,
  UnitStateFacts,
} from "../types";

export const DIAGNOSTIC_SECTIONS: DiagnosticSectionKind[] = [
  "state",
  "journal",
  "dependencies",
  "listeners",
];

export const JOURNAL_LINE_OPTIONS = [50, 100, 200, 500];
export const DEFAULT_JOURNAL_LINES = 200;

// Repeated on every section so no single card can be read as a verdict.
export const EVIDENCE_NOTICE =
  "Facts as the host reported them. Control Room does not infer a cause.";

const TITLES: Record<DiagnosticSectionKind, string> = {
  state: "Unit state",
  journal: "Recent journal",
  dependencies: "Dependencies",
  listeners: "Listening sockets",
};

export function sectionTitle(kind: DiagnosticSectionKind): string {
  return TITLES[kind];
}

// Mirrors the Rust rule. The backend decides for real and answers
// notApplicable for anything else, so this only keeps the UI from asking.
export function applicableSections(unit: string): DiagnosticSectionKind[] {
  if (unit.endsWith(".service") || unit.endsWith(".socket")) return DIAGNOSTIC_SECTIONS;
  return DIAGNOSTIC_SECTIONS.filter((kind) => kind !== "listeners");
}

export function isPermissionDenied(error: string): boolean {
  return error.toLowerCase().includes("permission denied");
}

export function formatCollectedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "unknown time";
  return at.toLocaleTimeString();
}

export function stateHeadline(state: UnitStateFacts): string {
  if (!state.known) return "Not loaded by systemd";
  const active = state.activeState ?? "unknown";
  const sub = state.subState;
  return sub ? `${active} (${sub})` : active;
}

// Exit facts in the host's own terms. When systemd reports a signal, the
// status field holds the signal number, so the two readings must not be mixed.
export function exitDetails(state: UnitStateFacts): string[] {
  const details: string[] = [];
  if (state.result) details.push(`Result reported by systemd: ${state.result}`);
  if (state.execMainCode === "exited" && state.execMainStatus !== null) {
    details.push(`Last main process exited with status ${state.execMainStatus}`);
  } else if (state.execMainCode?.startsWith("killed") && state.execMainStatus !== null) {
    details.push(`Last main process was killed by signal ${state.execMainStatus}`);
  } else if (state.execMainCode) {
    details.push(`Last main process ended with code ${state.execMainCode}`);
  }
  if (state.mainPid === null && state.execMainPid !== null) {
    details.push(`No running main process. The last one was PID ${state.execMainPid}`);
  }
  if (state.restartCount !== null && state.restartCount > 0) {
    details.push(`systemd has restarted this unit ${state.restartCount} times`);
  }
  if (state.conditionResult === false) details.push("A start condition was not met");
  if (state.assertResult === false) details.push("A start assertion failed");
  if (state.loadError) details.push(`Load error: ${state.loadError}`);
  return details;
}

// An inactive one-shot unit that succeeded is not a failure, and the view must
// not let the state word alone imply one.
export function oneShotNotice(state: UnitStateFacts): string | null {
  if (state.unitType !== "oneshot") return null;
  if (state.activeState !== "inactive") return null;
  if (state.result && state.result !== "success") return null;
  return "A one-shot unit that finished successfully reports inactive. That is not a failure.";
}

export function listenerHeadline(evidence: ListenerEvidence, unit: string): string {
  if (evidence.sockets.length) {
    const plural = evidence.sockets.length === 1 ? "listener" : "listeners";
    return `${evidence.sockets.length} ${plural} attributed to ${unit}`;
  }
  if (!evidence.ownershipComplete) {
    return `No listener was attributed to ${unit}, and owners were incomplete`;
  }
  return `No listening socket associated with ${unit} was detected`;
}

export function dependencySummary(section: ServiceDiagnosticSection): string | null {
  const facts = section.dependencies;
  if (!facts) return null;
  if (!facts.namedUnits) return "systemd reported no direct dependencies for this unit";
  const states = facts.statesResolved
    ? `states read for ${facts.resolvedUnits}`
    : "no states were read";
  return `${facts.namedUnits} directly named units, ${states}`;
}

export function statusLabel(section: ServiceDiagnosticSection): string {
  switch (section.status) {
    case "collected":
      return "collected";
    case "partial":
      return "partial";
    case "notApplicable":
      return "not applicable";
    default:
      return section.status;
  }
}
