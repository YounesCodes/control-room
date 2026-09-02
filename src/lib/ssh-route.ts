import type { RouteSegment, SshRoute } from "../types";

export const LOCAL_ONLY_NOTICE =
  "Read from the installed OpenSSH client. No host is contacted and no key is read.";

export function segmentTitle(segment: RouteSegment): string {
  return segment.alias;
}

// The alias the user wrote and the hostname OpenSSH resolved it to are two
// different facts, and the view is for the case where they differ.
export function resolvedHostNote(segment: RouteSegment): string | null {
  if (segment.kind === "origin") return null;
  if (!segment.hostname) return "OpenSSH reported no hostname for this alias";
  if (segment.hostname === segment.alias) return null;
  return `alias for ${segment.hostname}`;
}

export function segmentTarget(segment: RouteSegment): string {
  if (segment.kind === "origin") return "the local OpenSSH client";
  const host = segment.hostname ?? segment.alias;
  const user = segment.user ? `${segment.user}@` : "";
  const port = segment.port === null ? "" : `:${segment.port}`;
  return `${user}${host}${port}`;
}

export function segmentStatusLabel(segment: RouteSegment): string {
  switch (segment.status) {
    case "resolved":
      return "resolved";
    case "opaqueProxy":
      return "not interpretable";
    case "loop":
      return "loop";
    case "limit":
      return "limit reached";
    default:
      return "unresolved";
  }
}

export function unknownFields(segment: RouteSegment): string[] {
  if (segment.kind === "origin") return [];
  const missing: string[] = [];
  if (!segment.user) missing.push("user");
  if (segment.port === null) missing.push("port");
  if (!segment.hostname) missing.push("hostname");
  return missing;
}

export function routeHeadline(route: SshRoute): string {
  const hops = route.segments.filter((segment) => segment.kind === "jump").length;
  const base = hops
    ? `${hops} jump ${hops === 1 ? "host" : "hosts"} between this PC and the destination`
    : "Direct, with no jump host";
  if (route.status === "resolved") return base;
  return `${base}. Part of this route could not be interpreted`;
}

// Copyable values are facts OpenSSH reported. Identity files are listed by path
// only; Control Room never reads a key.
export function copyableValues(segment: RouteSegment): { label: string; value: string }[] {
  const values: { label: string; value: string }[] = [];
  if (segment.hostname) values.push({ label: "Hostname", value: segment.hostname });
  if (segment.user) values.push({ label: "User", value: segment.user });
  if (segment.port !== null) values.push({ label: "Port", value: String(segment.port) });
  for (const path of segment.identityFiles) {
    values.push({ label: "Identity file", value: path });
  }
  return values;
}
