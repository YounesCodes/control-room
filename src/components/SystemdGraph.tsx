import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Expand, GitBranch, X } from "lucide-react";
import { GraphControls } from "./GraphControls";
import { usePanZoom } from "../lib/use-pan-zoom";
import { observeLayoutFallback } from "./ResizablePanels";
import type { SystemdEdge } from "../lib/systemd-units";
import type { SystemdUnit } from "../types";

const WIDTH = 236;
const HEIGHT = 78;

export function SystemdGraph({
  ids,
  edges,
  units,
  rootId,
  selectedId,
  expanded,
  onSelect,
  onRefocus,
  onExpand,
  inspector,
}: {
  ids: string[];
  edges: SystemdEdge[];
  units: SystemdUnit[];
  rootId: string;
  selectedId: string | null;
  expanded: string[];
  onSelect: (id: string | null) => void;
  onRefocus: (id: string) => void;
  onExpand: (id: string) => void;
  inspector: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const wasInspecting = useRef(!!selectedId);
  const pan = usePanZoom(viewportRef);
  const { setView } = pan;
  const [moving, setMoving] = useState(false);
  const marker = useId().replace(/:/g, "");
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const layout = useMemo(() => {
    const distances = new Map([[rootId, 0]]);
    const queue = [rootId];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      for (const edge of edges) {
        const neighbor = edge.source === id ? edge.target : edge.target === id ? edge.source : null;
        if (neighbor && !distances.has(neighbor)) {
          distances.set(neighbor, (distances.get(id) ?? 0) + 1);
          queue.push(neighbor);
        }
      }
    }
    const columns = new Map<number, string[]>();
    for (const id of ids) {
      const depth = distances.get(id) ?? 1;
      const list = columns.get(depth) ?? [];
      list.push(id);
      columns.set(depth, list);
    }
    const positions = new Map<string, { x: number; y: number }>();
    let column = 0;
    const rows = Math.min(8, Math.max(1, ...[...columns.values()].map((list) => list.length)));
    for (const [, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
      list.forEach((id, index) =>
        positions.set(id, {
          x: 24 + (column + Math.floor(index / 8)) * 370,
          y: 24 + (id === rootId ? (rows - 1) / 2 : index % 8) * 112,
        }),
      );
      column += Math.ceil(list.length / 8);
    }
    return { positions, width: Math.max(320, column * 370), height: rows * 112 + 24 };
  }, [ids, edges, rootId]);

  const fit = useCallback(
    (animate = true) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const width = Math.max(
        100,
        viewport.clientWidth - (detailRef.current?.offsetWidth ?? 0) - 48,
      );
      const height = Math.max(100, viewport.clientHeight - 90);
      const scale = Math.max(0.01, Math.min(1, width / layout.width, height / layout.height));
      setMoving(animate);
      setView({
        scale,
        x: 24 + (width - layout.width * scale) / 2,
        y: 24 + (height - layout.height * scale) / 2,
      });
    },
    [layout.width, layout.height, setView],
  );

  useLayoutEffect(() => {
    fit();
  }, [fit, rootId, ids.join("\n")]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const resize = () => fit(false);
    if (typeof ResizeObserver === "undefined") return observeLayoutFallback(viewport, resize);
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fit]);
  useLayoutEffect(() => {
    if (selectedId) detailRef.current?.focus({ preventScroll: true });
    const opened = !!selectedId && !wasInspecting.current;
    wasInspecting.current = !!selectedId;
    if (opened) {
      const frame = requestAnimationFrame(() => fit());
      return () => cancelAnimationFrame(frame);
    }
  }, [selectedId, fit]);

  function close() {
    onSelect(null);
    (nodes.current.get(selectedId ?? rootId) ?? nodes.current.get(rootId))?.focus({
      preventScroll: true,
    });
    requestAnimationFrame(() => fit());
  }

  function reveal(element: HTMLButtonElement) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const node = element.getBoundingClientRect();
    const right = rect.right - (detailRef.current?.offsetWidth ?? 0) - 24;
    const dx =
      node.left < rect.left + 24
        ? rect.left + 24 - node.left
        : node.right > right
          ? right - node.right
          : 0;
    const dy =
      node.top < rect.top + 24
        ? rect.top + 24 - node.top
        : node.bottom > rect.bottom - 64
          ? rect.bottom - 64 - node.bottom
          : 0;
    if (dx || dy) {
      setMoving(true);
      setView((view) => ({ ...view, x: view.x + dx, y: view.y + dy }));
    }
  }

  return (
    <div
      className={"arch-canvas systemd-canvas" + (selectedId ? " inspecting" : "")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && selectedId) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <GraphControls
        scale={pan.view.scale}
        onZoom={(factor) => {
          setMoving(false);
          pan.zoomBy(factor);
        }}
        onFit={() => fit()}
      />
      <div
        className="arch-viewport"
        ref={viewportRef}
        role="region"
        tabIndex={0}
        aria-label="Systemd dependency graph"
        onWheel={(event) => {
          setMoving(false);
          pan.onWheel(event);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as Element).closest("button")) return;
          press.current = { x: event.clientX, y: event.clientY, moved: false };
          setMoving(false);
          pan.onPointerDown(event);
        }}
        onPointerMove={(event) => {
          if (
            press.current &&
            Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 5
          )
            press.current.moved = true;
          pan.onPointerMove(event);
        }}
        onPointerUp={(event) => {
          pan.onPointerUp(event);
          if (press.current && !press.current.moved) close();
          press.current = null;
        }}
        onPointerCancel={(event) => {
          press.current = null;
          pan.onPointerUp(event);
        }}
      >
        <div
          className={"systemd-graph-content" + (moving ? " arch-focusing" : "")}
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${pan.view.x}px, ${pan.view.y}px) scale(${pan.view.scale})`,
          }}
        >
          <svg
            className="systemd-edges"
            width={layout.width}
            height={layout.height}
            aria-label="Dependency relationships"
          >
            <defs>
              <marker
                id={marker}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            {edges.map((edge, index) => {
              const source = layout.positions.get(edge.source);
              const target = layout.positions.get(edge.target);
              if (!source || !target) return null;
              const forward = source.x < target.x;
              const x1 = source.x + (forward ? WIDTH : 0);
              const x2 = target.x + (forward ? 0 : WIDTH);
              const offset = ((index % 3) - 1) * 14;
              const y1 = source.y + HEIGHT / 2 + offset;
              const y2 = target.y + HEIGHT / 2 + offset;
              const mid = (x1 + x2) / 2;
              return (
                <g
                  key={edge.id}
                  className={"systemd-edge relationship-" + edge.relationship.toLowerCase()}
                >
                  <title>{edge.source + " " + edge.relationship + " " + edge.target}</title>
                  <path
                    d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                    markerEnd={`url(#${marker})`}
                  />
                  <text x={mid} y={(y1 + y2) / 2 - 5} textAnchor="middle">
                    {edge.relationship}
                  </text>
                </g>
              );
            })}
          </svg>
          {ids.map((id, index) => {
            const position = layout.positions.get(id)!;
            const unit = units.find((candidate) => candidate.id === id);
            return (
              <div
                key={id}
                className={"systemd-graph-node" + (id === rootId ? " graph-root" : "")}
                style={{ left: position.x, top: position.y, width: WIDTH, height: HEIGHT }}
              >
                <button
                  type="button"
                  className={"arch-chip" + (selectedId === id ? " selected" : "")}
                  title={id}
                  aria-pressed={selectedId === id}
                  aria-controls={selectedId === id ? "systemd-graph-inspector" : undefined}
                  ref={(element) => {
                    if (element) nodes.current.set(id, element);
                    else nodes.current.delete(id);
                  }}
                  onClick={() => onSelect(id)}
                  onDoubleClick={() => onRefocus(id)}
                  onFocus={(event) => {
                    if (event.currentTarget.matches(":focus-visible")) reveal(event.currentTarget);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && event.shiftKey) {
                      event.preventDefault();
                      onRefocus(id);
                      return;
                    }
                    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? ids.length - 1
                          : Math.max(
                              0,
                              Math.min(
                                ids.length - 1,
                                index + (event.key === "ArrowDown" ? 1 : -1),
                              ),
                            );
                    nodes.current.get(ids[next])?.focus();
                  }}
                >
                  <span className="arch-chip-title">
                    <GitBranch size={14} />
                    <strong>{id}</strong>{" "}
                  </span>
                  <span className="arch-chip-kind">
                    <span
                      className={"service-indicator service-" + (unit?.activeState ?? "unknown")}
                    />
                    {unit ? unit.activeState + " / " + unit.subState : "State not read"}
                  </span>
                </button>
                <button
                  className="icon-button systemd-expand"
                  type="button"
                  aria-label={(expanded.includes(id) ? "Collapse " : "Expand ") + id}
                  disabled={id === rootId || (!expanded.includes(id) && expanded.length >= 24)}
                  aria-pressed={id === rootId || expanded.includes(id)}
                  onClick={() => onExpand(id)}
                >
                  <Expand size={13} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {selectedId && (
        <aside
          className="detail-panel arch-detail"
          id="systemd-graph-inspector"
          ref={detailRef}
          aria-label="Unit details"
          tabIndex={-1}
        >
          <button
            className="icon-button inspector-close"
            type="button"
            aria-label="Close details"
            onClick={close}
          >
            <X size={16} />
          </button>
          {inspector}
        </aside>
      )}
    </div>
  );
}
