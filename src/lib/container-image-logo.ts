import catalog from "../assets/container-logos/catalog.json";

export interface ContainerImageLogo {
  slug: string;
  title: string;
  hex: string;
  displayHex: string;
}

const repositories = new Map<string, ContainerImageLogo>();
for (const [slug, logo] of Object.entries(catalog)) {
  for (const repository of logo.images) {
    repositories.set(repository, {
      slug,
      title: logo.title,
      hex: logo.hex,
      displayHex: logo.displayHex,
    });
  }
}

/** Match known repositories only, never container names or arbitrary registry basenames. */
export function containerImageLogo(image: string): ContainerImageLogo | null {
  let repository = image.trim().split("@")[0];
  const tag = repository.lastIndexOf(":");
  if (tag > repository.lastIndexOf("/")) repository = repository.slice(0, tag);
  repository = repository.replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "");
  if (repository.startsWith("library/") && repository.split("/").length === 2) {
    repository = repository.slice("library/".length);
  }
  return repositories.get(repository) ?? null;
}
