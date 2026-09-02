import type { ContainerImageFact, HostImageInventory } from "../types";

// Six is enough for the comparison the feature is for and keeps a run to a
// bounded number of hosts. Each host is read on its own, so a slow or refusing
// host never blocks the rest.
export const MAX_HOSTS = 6;

export type HostCollectionStatus = "idle" | "running" | "collected" | "failed";

export interface HostSlot {
  connectionId: string;
  displayName: string;
  status: HostCollectionStatus;
  inventory: HostImageInventory | null;
  error: string | null;
}

export type CellStatus = "matched" | "ambiguous" | "missing" | "notCollected" | "noIdentity";

export interface DriftCell {
  connectionId: string;
  status: CellStatus;
  candidates: ContainerImageFact[];
  selected: ContainerImageFact | null;
}

export type DriftVerdict =
  "same" | "sameTagDifferentImage" | "differentTagSameImage" | "differentImage" | "incomparable";

export interface DriftRow {
  key: string;
  project: string;
  service: string;
  cells: DriftCell[];
  comparedHosts: number;
  hostsWithoutEvidence: number;
  verdict: DriftVerdict;
  digestsEqual: boolean | null;
}

export function workloadKey(project: string, service: string): string {
  return `${project}/${service}`;
}

export function selectionKey(key: string, connectionId: string): string {
  return `${key}::${connectionId}`;
}

function candidatesFor(inventory: HostImageInventory, project: string, service: string) {
  return inventory.containers.filter(
    (fact) =>
      fact.container.composeProject === project && fact.container.composeService === service,
  );
}

function buildCell(
  slot: HostSlot,
  key: string,
  project: string,
  service: string,
  selections: Record<string, string>,
): DriftCell {
  if (slot.status !== "collected" || !slot.inventory) {
    return {
      connectionId: slot.connectionId,
      status: "notCollected",
      candidates: [],
      selected: null,
    };
  }
  const candidates = candidatesFor(slot.inventory, project, service);
  if (!candidates.length) {
    return { connectionId: slot.connectionId, status: "missing", candidates, selected: null };
  }
  // A scaled service gives several candidates. Which instance stands for the
  // workload is the user's call, so the cell stays unpaired until they say.
  const chosen =
    candidates.length === 1
      ? candidates[0]
      : (candidates.find(
          (fact) => fact.container.id === selections[selectionKey(key, slot.connectionId)],
        ) ?? null);
  if (!chosen) {
    return { connectionId: slot.connectionId, status: "ambiguous", candidates, selected: null };
  }
  if (!chosen.imageId) {
    return { connectionId: slot.connectionId, status: "noIdentity", candidates, selected: chosen };
  }
  return { connectionId: slot.connectionId, status: "matched", candidates, selected: chosen };
}

function comparableReference(fact: ContainerImageFact): string {
  return fact.recordedReference ?? fact.container.image;
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}

function verdictFor(cells: DriftCell[]): {
  verdict: DriftVerdict;
  comparedHosts: number;
  digestsEqual: boolean | null;
} {
  const compared = cells.filter((cell) => cell.status === "matched" && cell.selected?.imageId);
  if (compared.length < 2) {
    return { verdict: "incomparable", comparedHosts: compared.length, digestsEqual: null };
  }
  const selected = compared.map((cell) => cell.selected as ContainerImageFact);
  const imagesEqual = distinct(selected.map((fact) => fact.imageId as string)).length === 1;
  const tagsEqual = distinct(selected.map(comparableReference)).length === 1;
  // Digests are extra evidence, not the deciding one: an image built on the
  // host has none, so a missing digest must not read as a difference.
  const digests = selected.map((fact) => fact.repoDigests);
  const digestsEqual = digests.every((entry) => entry.length)
    ? distinct(digests.map((entry) => [...entry].sort().join(","))).length === 1
    : null;
  let verdict: DriftVerdict;
  if (imagesEqual) verdict = tagsEqual ? "same" : "differentTagSameImage";
  else verdict = tagsEqual ? "sameTagDifferentImage" : "differentImage";
  return { verdict, comparedHosts: compared.length, digestsEqual };
}

export function buildRows(slots: HostSlot[], selections: Record<string, string> = {}): DriftRow[] {
  const workloads = new Map<string, { project: string; service: string }>();
  for (const slot of slots) {
    if (slot.status !== "collected" || !slot.inventory) continue;
    for (const fact of slot.inventory.containers) {
      const { composeProject, composeService } = fact.container;
      if (!composeProject || !composeService) continue;
      workloads.set(workloadKey(composeProject, composeService), {
        project: composeProject,
        service: composeService,
      });
    }
  }
  return [...workloads.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, { project, service }]) => {
      const cells = slots.map((slot) => buildCell(slot, key, project, service, selections));
      const { verdict, comparedHosts, digestsEqual } = verdictFor(cells);
      return {
        key,
        project,
        service,
        cells,
        comparedHosts,
        hostsWithoutEvidence: cells.length - comparedHosts,
        verdict,
        digestsEqual,
      };
    });
}

const VERDICT_LABELS: Record<DriftVerdict, string> = {
  same: "Same image",
  sameTagDifferentImage: "Same tag, different image",
  differentTagSameImage: "Different tag, same image",
  differentImage: "Different image",
  incomparable: "Not comparable",
};

export function verdictLabel(verdict: DriftVerdict): string {
  return VERDICT_LABELS[verdict];
}

// Every summary names how many hosts contributed evidence, so agreement can
// never be read as agreement everywhere.
export function rowSummary(row: DriftRow): string {
  const total = row.cells.length;
  if (row.verdict === "incomparable") {
    return `Not comparable: ${row.comparedHosts} of ${total} hosts had comparable evidence`;
  }
  const base = `${verdictLabel(row.verdict)} across ${row.comparedHosts} of ${total} hosts`;
  if (!row.hostsWithoutEvidence) return base;
  const plural = row.hostsWithoutEvidence === 1 ? "host" : "hosts";
  return `${base}. ${row.hostsWithoutEvidence} ${plural} had no comparable evidence`;
}

export function digestNote(row: DriftRow): string {
  if (row.verdict === "incomparable") return "";
  if (row.digestsEqual === null)
    return "No registry digest on at least one host, so digests were not compared";
  return row.digestsEqual ? "Registry digests match" : "Registry digests differ";
}

export function cellStatusLabel(cell: DriftCell): string {
  switch (cell.status) {
    case "matched":
      return cell.selected?.container.state === "running" ? "running" : "not running";
    case "ambiguous":
      return `${cell.candidates.length} candidates, pick one`;
    case "missing":
      return "no container for this workload";
    case "noIdentity":
      return "image identity was not read";
    default:
      return "not collected";
  }
}

export function shortImageId(imageId: string | null): string {
  if (!imageId) return "unknown";
  const value = imageId.startsWith("sha256:") ? imageId.slice(7) : imageId;
  return value.slice(0, 12);
}

// Containers with no validated Compose project and service cannot be paired in
// this version. They are listed rather than silently dropped.
export function unpairedContainers(slot: HostSlot): ContainerImageFact[] {
  if (slot.status !== "collected" || !slot.inventory) return [];
  return slot.inventory.containers.filter(
    (fact) => !fact.container.composeProject || !fact.container.composeService,
  );
}

export function inventoryNotes(slot: HostSlot): string[] {
  const inventory = slot.inventory;
  if (slot.status !== "collected" || !inventory) return [];
  const notes: string[] = [];
  if (inventory.identityError) notes.push(inventory.identityError);
  if (inventory.truncated) {
    notes.push(
      `More than ${inventory.inspectedContainers} Compose containers on this host. Image identity was read for the first ones only.`,
    );
  }
  if (!inventory.identityComplete && !inventory.identityError) {
    notes.push("At least one container returned no image identity.");
  }
  if (!inventory.digestEvidenceAvailable) {
    notes.push("This host reported no registry digests. Local image ids are still comparable.");
  }
  return notes;
}
