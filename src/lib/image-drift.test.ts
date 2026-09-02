import { describe, expect, it } from "vitest";
import {
  MAX_HOSTS,
  buildRows,
  cellStatusLabel,
  digestNote,
  inventoryNotes,
  rowSummary,
  selectionKey,
  shortImageId,
  unpairedContainers,
  verdictLabel,
  workloadKey,
} from "./image-drift";
import type { HostSlot } from "./image-drift";
import type { ContainerImageFact, DockerContainer, HostImageInventory } from "../types";

function container(overrides: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: "a".repeat(64),
    name: "shop-web-1",
    image: "example/web:latest",
    state: "running",
    status: "Up 2 hours",
    ports: "",
    createdAt: "",
    composeProject: "shop",
    composeService: "web",
    composeContainerNumber: 1,
    composeOneoff: false,
    ...overrides,
  };
}

function fact(overrides: Partial<ContainerImageFact> = {}): ContainerImageFact {
  return {
    container: container(),
    recordedReference: "example/web:latest",
    imageId: "sha256:1111111111111111",
    repoDigests: ["sha256:aaaaaaaaaaaaaaaa"],
    ...overrides,
  };
}

function inventory(
  connectionId: string,
  containers: ContainerImageFact[],
  overrides: Partial<HostImageInventory> = {},
): HostImageInventory {
  return {
    connectionId,
    collectedAt: "2026-09-02T10:00:00Z",
    containers,
    inspectedContainers: containers.length,
    truncated: false,
    identityComplete: true,
    digestEvidenceAvailable: true,
    identityError: null,
    ...overrides,
  };
}

function slot(
  connectionId: string,
  containers: ContainerImageFact[],
  overrides: Partial<HostSlot> = {},
): HostSlot {
  return {
    connectionId,
    displayName: connectionId,
    status: "collected",
    inventory: inventory(connectionId, containers),
    error: null,
    ...overrides,
  };
}

describe("workload pairing", () => {
  it("pairs by validated Compose project and service", () => {
    const rows = buildRows([slot("host-a", [fact()]), slot("host-b", [fact()])]);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(workloadKey("shop", "web"));
    expect(rows[0].cells.map((cell) => cell.status)).toEqual(["matched", "matched"]);
  });

  it("leaves a container without Compose identity unpaired instead of matching on name", () => {
    const orphan = fact({
      container: container({ composeProject: null, composeService: null, name: "web" }),
    });
    const hosts = [slot("host-a", [orphan]), slot("host-b", [orphan])];
    expect(buildRows(hosts)).toHaveLength(0);
    expect(unpairedContainers(hosts[0])).toHaveLength(1);
  });

  it("marks a scaled service ambiguous until the user picks an instance", () => {
    const first = fact({ container: container({ id: "b".repeat(64), name: "shop-web-1" }) });
    const second = fact({
      container: container({ id: "c".repeat(64), name: "shop-web-2", composeContainerNumber: 2 }),
      imageId: "sha256:2222222222222222",
    });
    const hosts = [slot("host-a", [first, second]), slot("host-b", [fact()])];
    const ambiguous = buildRows(hosts);
    expect(ambiguous[0].cells[0].status).toBe("ambiguous");
    expect(ambiguous[0].cells[0].candidates).toHaveLength(2);
    expect(ambiguous[0].verdict).toBe("incomparable");

    const picked = buildRows(hosts, {
      [selectionKey(workloadKey("shop", "web"), "host-a")]: "c".repeat(64),
    });
    expect(picked[0].cells[0].status).toBe("matched");
    expect(picked[0].cells[0].selected?.container.name).toBe("shop-web-2");
    expect(picked[0].verdict).toBe("sameTagDifferentImage");
  });

  it("reports a host with no container for the workload as missing", () => {
    const rows = buildRows([slot("host-a", [fact()]), slot("host-b", [])]);
    expect(rows[0].cells[1].status).toBe("missing");
    expect(cellStatusLabel(rows[0].cells[1])).toBe("no container for this workload");
  });

  it("reports a host that could not be read as not collected", () => {
    const rows = buildRows([
      slot("host-a", [fact()]),
      slot("host-b", [], { status: "failed", inventory: null, error: "Permission denied" }),
    ]);
    expect(rows[0].cells[1].status).toBe("notCollected");
    expect(cellStatusLabel(rows[0].cells[1])).toBe("not collected");
  });

  it("keeps a container whose image identity was not read out of the comparison", () => {
    const rows = buildRows([slot("host-a", [fact()]), slot("host-b", [fact({ imageId: null })])]);
    expect(rows[0].cells[1].status).toBe("noIdentity");
    expect(rows[0].comparedHosts).toBe(1);
    expect(rows[0].verdict).toBe("incomparable");
  });

  it("labels a stopped container as evidence that is not running", () => {
    const rows = buildRows([
      slot("host-a", [fact()]),
      slot("host-b", [fact({ container: container({ state: "exited", status: "Exited (1)" }) })]),
    ]);
    expect(rows[0].cells[1].status).toBe("matched");
    expect(cellStatusLabel(rows[0].cells[1])).toBe("not running");
    expect(rows[0].comparedHosts).toBe(2);
  });

  it("sorts rows by workload key so the same input always renders the same way", () => {
    const api = fact({
      container: container({ composeService: "api", name: "shop-api-1", id: "d".repeat(64) }),
    });
    const rows = buildRows([slot("host-a", [fact(), api])]);
    expect(rows.map((row) => row.key)).toEqual(["shop/api", "shop/web"]);
  });
});

describe("verdicts", () => {
  it("compares tags separately from immutable image ids", () => {
    const rows = buildRows([
      slot("host-a", [fact()]),
      slot("host-b", [fact({ imageId: "sha256:2222222222222222" })]),
    ]);
    expect(rows[0].verdict).toBe("sameTagDifferentImage");
    expect(verdictLabel(rows[0].verdict)).toBe("Same tag, different image");
  });

  it("reports the same image under two tags as the same image", () => {
    const rows = buildRows([
      slot("host-a", [fact({ recordedReference: "example/web:1.4" })]),
      slot("host-b", [fact({ recordedReference: "example/web:latest" })]),
    ]);
    expect(rows[0].verdict).toBe("differentTagSameImage");
  });

  it("reports agreement only for the hosts that supplied evidence", () => {
    const rows = buildRows([
      slot("host-a", [fact()]),
      slot("host-b", [fact()]),
      slot("host-c", [], { status: "failed", inventory: null, error: "Connection refused" }),
      slot("host-d", []),
    ]);
    expect(rows[0].verdict).toBe("same");
    expect(rows[0].comparedHosts).toBe(2);
    expect(rows[0].hostsWithoutEvidence).toBe(2);
    expect(rowSummary(rows[0])).toBe(
      "Same image across 2 of 4 hosts. 2 hosts had no comparable evidence",
    );
  });

  it("refuses to compare a single host", () => {
    const rows = buildRows([slot("host-a", [fact()])]);
    expect(rows[0].verdict).toBe("incomparable");
    expect(rowSummary(rows[0])).toBe("Not comparable: 1 of 1 hosts had comparable evidence");
  });

  it("reports differing tags and images together", () => {
    const rows = buildRows([
      slot("host-a", [fact({ recordedReference: "example/web:1.4" })]),
      slot("host-b", [
        fact({ recordedReference: "example/web:1.5", imageId: "sha256:2222222222222222" }),
      ]),
    ]);
    expect(rows[0].verdict).toBe("differentImage");
  });

  it("falls back to the listed reference when none was recorded on the container", () => {
    const rows = buildRows([
      slot("host-a", [fact({ recordedReference: null })]),
      slot("host-b", [fact({ recordedReference: null })]),
    ]);
    expect(rows[0].verdict).toBe("same");
  });
});

describe("digest evidence", () => {
  it("compares digests when both hosts have one", () => {
    const rows = buildRows([
      slot("host-a", [fact()]),
      slot("host-b", [fact({ repoDigests: ["sha256:bbbbbbbbbbbbbbbb"] })]),
    ]);
    expect(rows[0].digestsEqual).toBe(false);
    expect(digestNote(rows[0])).toBe("Registry digests differ");
  });

  it("does not treat a missing digest as a difference", () => {
    const rows = buildRows([slot("host-a", [fact()]), slot("host-b", [fact({ repoDigests: [] })])]);
    expect(rows[0].digestsEqual).toBeNull();
    expect(digestNote(rows[0])).toBe(
      "No registry digest on at least one host, so digests were not compared",
    );
    expect(rows[0].verdict).toBe("same");
  });

  it("treats several digests on one image as one value", () => {
    const rows = buildRows([
      slot("host-a", [
        fact({ repoDigests: ["sha256:aaaaaaaaaaaaaaaa", "sha256:cccccccccccccccc"] }),
      ]),
      slot("host-b", [
        fact({ repoDigests: ["sha256:cccccccccccccccc", "sha256:aaaaaaaaaaaaaaaa"] }),
      ]),
    ]);
    expect(rows[0].digestsEqual).toBe(true);
  });
});

describe("host notes", () => {
  it("says when a host reported no digests at all", () => {
    const host = slot("host-a", [fact()]);
    host.inventory = inventory("host-a", [fact()], { digestEvidenceAvailable: false });
    expect(inventoryNotes(host)).toContain(
      "This host reported no registry digests. Local image ids are still comparable.",
    );
  });

  it("passes through the identity failure without hiding the container list", () => {
    const host = slot("host-a", [fact({ imageId: null })]);
    host.inventory = inventory("host-a", [fact({ imageId: null })], {
      identityError: "Image identity could not be read on this host.",
      identityComplete: false,
    });
    expect(inventoryNotes(host)).toContain("Image identity could not be read on this host.");
    expect(host.inventory.containers).toHaveLength(1);
  });

  it("says when identity was incomplete without a hard failure", () => {
    const host = slot("host-a", [fact()]);
    host.inventory = inventory("host-a", [fact()], { identityComplete: false });
    expect(inventoryNotes(host)).toContain("At least one container returned no image identity.");
  });

  it("reports a truncated inspection", () => {
    const host = slot("host-a", [fact()]);
    host.inventory = inventory("host-a", [fact()], { truncated: true, inspectedContainers: 200 });
    expect(inventoryNotes(host)[0]).toContain("200");
  });

  it("has nothing to say about a host that was never read", () => {
    expect(inventoryNotes(slot("host-a", [], { status: "idle", inventory: null }))).toEqual([]);
  });
});

describe("formatting", () => {
  it("shortens an image id without pretending to know an unknown one", () => {
    expect(shortImageId("sha256:1111111111111111")).toBe("111111111111");
    expect(shortImageId(null)).toBe("unknown");
  });

  it("bounds a comparison to a handful of hosts", () => {
    expect(MAX_HOSTS).toBe(6);
  });
});
