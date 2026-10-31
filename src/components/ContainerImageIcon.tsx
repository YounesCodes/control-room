import type { CSSProperties } from "react";
import { Container } from "lucide-react";
import { containerImageLogo } from "../lib/container-image-logo";

// Emit local SVG assets rather than inlining the entire catalog into the JS bundle.
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
