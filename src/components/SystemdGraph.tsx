import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Expand, X } from "lucide-react";
import { SystemdPresence } from "./SystemdPresence";
import { GraphControls } from "./GraphControls";
import { usePanZoom } from "../lib/use-pan-zoom";
import { observeLayoutFallback } from "./ResizablePanels";
import { systemdStateLabel, type SystemdEdge } from "../lib/systemd-units";
import type { SystemdUnit } from "../types";
import { layoutSystemdGraph } from "../lib/systemd-graph-layout";

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
  frameKey = "",
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
  frameKey?: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const wasInspecting = useRef(!!selectedId);
  const pan = usePanZoom(viewportRef);
  const { setView } = pan;
  const [moving, setMoving] = useState(false);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const previous = useRef<{
    root: string;
    frame: string;
    layout: ReturnType<typeof layoutSystemdGraph>;
  } | null>(null);
  const cameraTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeEdge, setActiveEdge] = useState<string | null>(null);
  const layout = useMemo(() => {
    const old = previous.current;
    const growing =
      old?.root === rootId &&
      old.frame === frameKey &&
      [...old.layout.positions.keys()].every((id) => ids.includes(id));
    return layoutSystemdGraph(ids, edges, rootId, growing ? old.layout.placements : undefined);
  }, [ids, edges, rootId, frameKey]);

  const fit = useCallback(
    (animate = true, entire = false) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const width = Math.max(
        100,
        viewport.clientWidth - (selectedId ? (detailRef.current?.offsetWidth ?? 0) : 0) - 48,
      );
      const height = Math.max(100, viewport.clientHeight - 108);
      const natural = Math.min(1, width / layout.width, height / layout.height);
      const scale = Math.max(entire ? 0.01 : 0.85, natural);
      const root = layout.positions.get(rootId)!;
      const centerX = natural < scale ? root.x + root.width / 2 : layout.width / 2;
      const centerY = natural < scale ? root.y + root.height / 2 : layout.height / 2;
      setMoving(animate);
      setView({ scale, x: 24 + width / 2 - centerX * scale, y: 48 + height / 2 - centerY * scale });
    },
    [layout, rootId, selectedId, setView],
  );

  useLayoutEffect(() => {
    const old = previous.current;
    if (old && old.root === rootId && old.frame === frameKey) {
      const before = old.layout.positions.get(rootId)!;
      const after = layout.positions.get(rootId)!;
      setView((view) => ({
        ...view,
        x: view.x + (before.x - after.x) * view.scale,
        y: view.y + (before.y - after.y) * view.scale,
      }));
    } else fit();
    previous.current = { root: rootId, frame: frameKey, layout };
  }, [layout, rootId, frameKey, fit, setView]);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let width = viewport.clientWidth,
      height = viewport.clientHeight;
    const resize = () => {
      if (width === viewport.clientWidth && height === viewport.clientHeight) return;
      width = viewport.clientWidth;
      height = viewport.clientHeight;
      fitRef.current(false);
    };
    if (typeof ResizeObserver === "undefined") return observeLayoutFallback(viewport, resize);
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (cameraTimer.current) clearTimeout(cameraTimer.current);
    if (selectedId) {
      detailRef.current?.focus({ preventScroll: true });
      wasInspecting.current = true;
      cameraTimer.current = setTimeout(() => {
        const viewport = viewportRef.current,
          node = previous.current?.layout.positions.get(selectedId);
        if (!viewport || !node) return;
        const width = viewport.clientWidth - (detailRef.current?.offsetWidth ?? 0) - 48;
        if (width < 240) return;
        const height = Math.max(100, viewport.clientHeight - 108);
        const scale = Math.max(
          0.85,
          Math.min(1.1, width / (node.width + 48), height / (node.height + 64)),
        );
        setMoving(true);
        setView({
          scale,
          x: 24 + width / 2 - (node.x + node.width / 2) * scale,
          y: 48 + height / 2 - (node.y + node.height / 2) * scale,
        });
      }, 220);
    } else if (wasInspecting.current) {
      wasInspecting.current = false;
      fit();
    }
    return () => {
      if (cameraTimer.current) clearTimeout(cameraTimer.current);
    };
  }, [selectedId]);

  function stopCamera() {
    if (cameraTimer.current) clearTimeout(cameraTimer.current);
    setMoving(false);
  }

  function close() {
    onSelect(null);
    const node = nodes.current.get(selectedId ?? rootId) ?? nodes.current.get(rootId);
    requestAnimationFrame(() => node?.focus({ preventScroll: true }));
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
          stopCamera();
          pan.zoomBy(factor);
        }}
        onFit={() => {
          stopCamera();
          fit(true, true);
        }}
      />
      <div className="systemd-direction-key" aria-label="Arrow direction">
        {frameKey.startsWith("ordering")
          ? "A → B: A is ordered before B"
          : frameKey.startsWith("activation")
            ? "A → B: A activates B"
            : "A → B: A requires or wants B"}
      </div>
      <div
        className="arch-viewport"
        ref={viewportRef}
        role="region"
        tabIndex={0}
        aria-label="Systemd dependency graph"
        onWheel={(event) => {
          stopCamera();
          pan.onWheel(event);
        }}
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            (event.target as Element).closest("button, .systemd-connection")
          )
            return;
          press.current = { x: event.clientX, y: event.clientY, moved: false };
          stopCamera();
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
          if (press.current && !press.current.moved && selectedId) close();
          press.current = null;
        }}
        onPointerCancel={(event) => {
          press.current = null;
          pan.onPointerUp(event);
        }}
      >
        <div
          className={"systemd-graph-content" + (moving ? " arch-focusing" : "")}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === "transform")
              setMoving(false);
          }}
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
            {layout.connections.map((connection) => {
              const evidence = connection.edges
                .map((edge) => edge.source + " " + edge.relationship + " " + edge.target)
                .join("; ");
              return (
                <g
                  key={connection.id}
                  className={
                    "systemd-connection relationship-" +
                    connection.kind +
                    (activeEdge === connection.id ? " edge-active" : "")
                  }
                  tabIndex={0}
                  role="img"
                  aria-label={evidence}
                  onMouseEnter={() => setActiveEdge(connection.id)}
                  onMouseLeave={() => setActiveEdge(null)}
                  onFocus={() => setActiveEdge(connection.id)}
                  onBlur={() => setActiveEdge(null)}
                >
                  <title>{evidence}</title>
                  <path
                    className="systemd-edge-path"
                    d={connection.path}
                    vectorEffect="non-scaling-stroke"
                  />
                  <path className="systemd-arrowhead" d={connection.arrowhead} />
                  <text
                    className="systemd-edge-label"
                    x={connection.labelPoint.x}
                    y={connection.labelPoint.y}
                    textAnchor="middle"
                  >
                    {connection.label}
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
                style={{
                  left: position.x,
                  top: position.y,
                  width: position.width,
                  height: position.height,
                }}
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
                  onDoubleClick={() => {
                    stopCamera();
                    onRefocus(id);
                  }}
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
                    <strong>{id}</strong>{" "}
                  </span>
                  <span className="arch-chip-kind">
                    <span
                      className={"service-indicator service-" + (unit?.activeState ?? "unknown")}
                    />
                    {systemdStateLabel(unit?.activeState, unit?.subState)}
                  </span>
                </button>
                {id !== rootId && (
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
                )}
              </div>
            );
          })}
        </div>
      </div>
      <SystemdPresence open={!!selectedId}>
        <aside
          className="detail-panel arch-detail systemd-inspector"
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
      </SystemdPresence>
    </div>
  );
}
