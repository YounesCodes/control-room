import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import catalog from "../assets/container-logos/catalog.json";
import { containerImageLogo } from "./container-image-logo";

describe("container image identities", () => {
  it.each([
    "postgres",
    "postgres:17-alpine",
    "library/postgres:17",
    "docker.io/library/postgres:17",
    "index.docker.io/postgres@sha256:abc",
    "registry-1.docker.io/library/postgres:17@sha256:abc",
    "bitnami/postgresql:17",
    "pgvector/pgvector:pg17",
  ])("recognizes PostgreSQL reference %s", (image) => {
    expect(containerImageLogo(image)?.slug).toBe("postgresql");
  });
  it.each([
    "",
    "sha256:abc",
    "mycompany/redis",
    "registry.example:5000/redis:7",
    "registry.example/nginx",
    "redis-backup",
    "my-postgres",
    "ghcr.io/random/immich-server",
    "docker.io/untrusted/postgres",
    "https://docker.io/postgres",
    "postgresql",
  ])("keeps unrecognized reference %s generic", (image) => {
    expect(containerImageLogo(image)).toBeNull();
  });
  it("recognizes explicitly supported non-Hub repositories", () => {
    expect(containerImageLogo("ghcr.io/immich-app/immich-server:release")?.slug).toBe("immich");
    expect(containerImageLogo("lscr.io/linuxserver/jellyfin:latest")?.slug).toBe("jellyfin");
    expect(containerImageLogo("mcr.microsoft.com/dotnet/aspnet:9.0")?.slug).toBe("dotnet");
  });
  it("bundles a safe SVG and provenance for every unique catalog entry", () => {
    const images = new Set<string>();
    const directory = new URL("../assets/container-logos/", import.meta.url);
    expect(readdirSync(directory).filter((name) => name.endsWith(".svg")).length).toBe(
      Object.keys(catalog).length,
    );
    for (const [slug, logo] of Object.entries(catalog)) {
      const svg = readFileSync(new URL(`${slug}.svg`, directory), "utf8");
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).not.toMatch(/<(?:script|foreignObject|image)\b|\bon\w+=|href=/i);
      expect(logo.upstream).toMatch(/simple-icons\/[a-f0-9]{40}\/icons\//);
      expect(logo.source).toMatch(/^https:\/\//);
      expect(logo.license.type).toBeTruthy();
      expect(logo.displayHex).toMatch(/^[0-9A-F]{6}$/);
      for (const image of logo.images) {
        expect(images.has(image), `Duplicate image alias ${image}`).toBe(false);
        images.add(image);
        expect(containerImageLogo(image)?.slug).toBe(slug);
      }
    }
  });
});
