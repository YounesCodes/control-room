import { Scan } from "lucide-react";
import { ZoomIn, ZoomOut } from "./MagnifierIcon";

export function GraphControls({
  scale,
  onZoom,
  onFit,
}: {
  scale: number;
  onZoom: (factor: number) => void;
  onFit: () => void;
}) {
  return (
    <div className="graph-toolbar" role="toolbar" aria-label="Graph controls">
      <button
        type="button"
        className="icon-button"
        aria-label="Zoom out"
        onClick={() => onZoom(1 / 1.2)}
      >
        <ZoomOut size={15} />
      </button>
      <span className="zoom-level">{Math.round(scale * 100)}%</span>
      <button
        type="button"
        className="icon-button"
        aria-label="Zoom in"
        onClick={() => onZoom(1.2)}
      >
        <ZoomIn size={15} />
      </button>
      <button type="button" className="icon-button" aria-label="Fit to view" onClick={onFit}>
        <Scan size={15} />
      </button>
    </div>
  );
}
