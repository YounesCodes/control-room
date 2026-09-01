import type { DockerContainer, SystemdUnit, TerminalContextReference } from "../types";

export type ContextResolution<T> =
  { status: "resolved"; match: T } | { status: "missing" } | { status: "ambiguous"; count: number };

export function resolveSystemdUnit(
  units: SystemdUnit[],
  reference: string,
): ContextResolution<SystemdUnit> {
  const matches = units.filter((unit) => unit.id === reference);
  return single(matches);
}

// Follows Docker's own rules: an exact name or full id wins, and a short id
// prefix resolves only when it matches one container.
export function resolveDockerContainer(
  containers: DockerContainer[],
  reference: string,
): ContextResolution<DockerContainer> {
  const exact = containers.filter(
    (container) => container.name === reference || container.id === reference,
  );
  if (exact.length) return single(exact);
  if (!/^[0-9a-f]+$/.test(reference)) return { status: "missing" };
  return single(containers.filter((container) => container.id.startsWith(reference)));
}

function single<T>(matches: T[]): ContextResolution<T> {
  if (matches.length === 1) return { status: "resolved", match: matches[0] };
  if (matches.length === 0) return { status: "missing" };
  return { status: "ambiguous", count: matches.length };
}

export function contextKindLabel(reference: TerminalContextReference): string {
  return reference.kind === "systemdUnit" ? "Systemd unit" : "Container";
}

export function unresolvedMessage(
  reference: TerminalContextReference,
  resolution: ContextResolution<unknown>,
): string | null {
  const object = contextKindLabel(reference).toLowerCase();
  if (resolution.status === "missing") {
    return `No ${object} named ${reference.id} is in the current list.`;
  }
  if (resolution.status === "ambiguous") {
    return `${reference.id} matches ${resolution.count} ${object}s. Use the full name or id.`;
  }
  return null;
}
