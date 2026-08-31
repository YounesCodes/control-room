import type { DockerContainer } from "../types";

export interface DockerContainerGroup {
  id: string;
  label: string;
  project: string | null;
  containers: DockerContainer[];
}

function compareText(left: string, right: string) {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function matches(container: DockerContainer, query: string) {
  return [
    container.id,
    container.name,
    container.image,
    container.composeProject,
    container.composeService,
  ].some((value) => value?.toLowerCase().includes(query));
}

function compareContainers(left: DockerContainer, right: DockerContainer) {
  const service = compareText(left.composeService ?? left.name, right.composeService ?? right.name);
  if (service) return service;
  const instance =
    (left.composeContainerNumber ?? Number.MAX_SAFE_INTEGER) -
    (right.composeContainerNumber ?? Number.MAX_SAFE_INTEGER);
  if (instance) return instance;
  const name = compareText(left.name, right.name);
  return name || compareText(left.id, right.id);
}

export function filterDockerContainers(containers: DockerContainer[], search: string) {
  const query = search.trim().toLowerCase();
  return query ? containers.filter((container) => matches(container, query)) : containers;
}

export function groupDockerContainers(
  containers: DockerContainer[],
  search = "",
): DockerContainerGroup[] {
  const query = search.trim().toLowerCase();
  const projects = new Map<string, DockerContainer[]>();
  const ungrouped: DockerContainer[] = [];

  for (const container of containers) {
    if (!container.composeProject || !container.composeService) {
      if (!query || matches(container, query)) ungrouped.push(container);
      continue;
    }

    const projectMatches = container.composeProject.toLowerCase().includes(query);
    if (query && !projectMatches && !matches(container, query)) continue;
    const projectContainers = projects.get(container.composeProject) ?? [];
    projectContainers.push(container);
    projects.set(container.composeProject, projectContainers);
  }

  const groups: DockerContainerGroup[] = [...projects.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([project, projectContainers]) => ({
      id: `project:${project}`,
      label: project,
      project,
      containers: projectContainers.sort(compareContainers),
    }));

  groups.push({
    id: "ungrouped",
    label: "Ungrouped",
    project: null,
    containers: ungrouped.sort(compareContainers),
  });
  return groups;
}

export function composeContainerLabel(container: DockerContainer) {
  if (!container.composeService) return container.name;
  const instance = container.composeContainerNumber ? ` #${container.composeContainerNumber}` : "";
  const oneoff = container.composeOneoff ? " · one-off" : "";
  return `${container.composeService}${instance}${oneoff}`;
}
