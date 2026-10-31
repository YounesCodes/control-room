import type { SVGProps } from "react";

// Phosphor Icons, bold magnifying-glass family (MIT).
// https://github.com/phosphor-icons/core
// License ships in public/third-party/phosphor-LICENSE.txt.
type MagnifierProps = SVGProps<SVGSVGElement> & { size?: number | string };
const paths = {
  search:
    "M232.49,215.51,185,168a92.12,92.12,0,1,0-17,17l47.53,47.54a12,12,0,0,0,17-17ZM44,112a68,68,0,1,1,68,68A68.07,68.07,0,0,1,44,112Z",
  "zoom-in":
    "M156,112a12,12,0,0,1-12,12H124v20a12,12,0,0,1-24,0V124H80a12,12,0,0,1,0-24h20V80a12,12,0,0,1,24,0v20h20A12,12,0,0,1,156,112Zm76.49,120.49a12,12,0,0,1-17,0L168,185a92.12,92.12,0,1,1,17-17l47.54,47.53A12,12,0,0,1,232.49,232.49ZM112,180a68,68,0,1,0-68-68A68.08,68.08,0,0,0,112,180Z",
  "zoom-out":
    "M156,112a12,12,0,0,1-12,12H80a12,12,0,0,1,0-24h64A12,12,0,0,1,156,112Zm76.49,120.49a12,12,0,0,1-17,0L168,185a92.12,92.12,0,1,1,17-17l47.54,47.53A12,12,0,0,1,232.49,232.49ZM112,180a68,68,0,1,0-68-68A68.08,68.08,0,0,0,112,180Z",
};

function Magnifier({
  variant,
  size = 16,
  className = "",
  ...props
}: MagnifierProps & { variant: keyof typeof paths }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
      className={"magnifier-icon magnifier-" + variant + (className ? " " + className : "")}
      {...props}
    >
      <path d={paths[variant]} />
    </svg>
  );
}

export function Search(props: MagnifierProps) {
  return <Magnifier variant="search" {...props} />;
}
export function ZoomIn(props: MagnifierProps) {
  return <Magnifier variant="zoom-in" {...props} />;
}
export function ZoomOut(props: MagnifierProps) {
  return <Magnifier variant="zoom-out" {...props} />;
}
