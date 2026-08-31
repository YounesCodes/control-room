import { describe, expect, it } from "vitest";
import type { DockerContainer } from "../types";
import {
  composeContainerLabel,
  filterDockerContainers,
  groupDockerContainers,
} from "./docker-compose-grouping";

function container(
  id: string,
  name: string,
  composeProject: string | null,
  composeService: string | null,
  composeContainerNumber: number | null = null,
  composeOneoff: boolean | null = null,
): DockerContainer {
  return {
    id,
    name,
    image: `${name}:latest`,
    state: "running",
    status: "Up",
    ports: "",
    createdAt: "today",
    composeProject,
    composeService,
    composeContainerNumber,
    composeOneoff,
  };
}

describe("Docker Compose grouping", () => {
  const fixtures = [
    container("web-2", "shop-web-2", "shop", "web", 2, false),
    container("solo", "watchtower", null, null),
    container("job", "shop-migrate-run", "shop", "migrate", 1, true),
    container("api", "billing-api-1", "billing", "api", 1, false),
    container("web-1", "shop-web-1", "shop", "web", 1, false),
    container("bad", "bad-compose", "shop", null),
  ];

  it("groups projects, replicas, one-offs, and standalone containers exactly once", () => {
    const groups = groupDockerContainers(fixtures);

    expect(groups.map((group) => group.label)).toEqual(["billing", "shop", "Ungrouped"]);
    expect(groups[1].containers.map((item) => item.id)).toEqual(["job", "web-1", "web-2"]);
    expect(groups.at(-1)?.containers.map((item) => item.id)).toEqual(["bad", "solo"]);
    expect(groups.flatMap((group) => group.containers)).toHaveLength(fixtures.length);
    expect(new Set(groups.flatMap((group) => group.containers.map((item) => item.id))).size).toBe(
      fixtures.length,
    );
    expect(composeContainerLabel(groups[1].containers[0])).toBe("migrate #1 · one-off");
    expect(composeContainerLabel(groups[1].containers[2])).toBe("web #2");
  });

  it("keeps Ungrouped available when it is empty", () => {
    const groups = groupDockerContainers([container("api", "api-1", "shop", "api", 1)]);
    expect(groups.at(-1)).toMatchObject({ label: "Ungrouped", containers: [] });
  });

  it("searches project, service, actual name, image, and ID", () => {
    expect(groupDockerContainers(fixtures, "shop")[0].containers).toHaveLength(3);
    expect(groupDockerContainers(fixtures, "web")[0].containers.map((item) => item.id)).toEqual([
      "web-1",
      "web-2",
    ]);
    expect(filterDockerContainers(fixtures, "billing-api").map((item) => item.id)).toEqual(["api"]);
    expect(filterDockerContainers(fixtures, "solo").map((item) => item.id)).toEqual(["solo"]);
  });
});
