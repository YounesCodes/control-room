import type { CSSProperties } from "react";
import { Container } from "lucide-react";
import { containerImageLogo } from "../lib/container-image-logo";

// Emit local SVG assets rather than inlining the entire catalog into the JS bundle.
// Artwork is unmodified Simple Icons; catalog.json carries the per-logo provenance
// and licenses, and the Simple Icons license and disclaimer sit next to the SVGs.
const assets = import.meta.glob<string>("../assets/container-logos/*.svg", {
  eager: true,
  query: "?url&no-inline",
  import: "default",
});

export function ContainerImageIcon({ image, size = 14 }: { image: string; size?: number }) {
  const logo = containerImageLogo(image);
  const url = logo && assets[`../assets/container-logos/${logo.slug}.svg`];
  if (!logo || !url) return <Container size={size} aria-hidden="true" />;
  return (
    <span
      className="docker-image-icon"
      role="img"
      aria-label={`${logo.title} image`}
      style={
        {
          "--image-brand": `#${logo.displayHex}`,
          "--image-logo": `url("${url}")`,
          width: size,
          height: size,
        } as CSSProperties
      }
    />
  );
}

/// A Container Terminal's identity mark in tabs, menus, and the host's leaf:
/// the image logo in the shared identity footprint, gray at rest, revealing
/// the image's brand color where other OS and shell marks reveal theirs.
export function ContainerTerminalMark({ image }: { image: string }) {
  const logo = containerImageLogo(image);
  return (
    <span
      className="host-os-icon identity-mark container-terminal-mark"
      aria-hidden="true"
      style={
        {
          "--identity": logo ? `#${logo.displayHex}` : "var(--text-strong)",
        } as CSSProperties
      }
    >
      <ContainerImageIcon image={image} size={15} />
    </span>
  );
}
