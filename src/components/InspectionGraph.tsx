import { GraphControls } from "./GraphControls";
import { observeLayoutFallback } from "./ResizablePanels";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Server, X } from "lucide-react";
import { EmptyState, LoadingState } from "./PanelState";
import { usePanZoom } from "../lib/use-pan-zoom";

export interface InspectionGraphItem {
  id: string;
  content: ReactNode;
  secondary?: boolean;
}

export interface InspectionGraphGroup {
  id: string;
  label: string;
  icon: ReactNode;
  className?: string;
  items: InspectionGraphItem[];
}

export function InspectionGraph({
  groups,
  hostLabel,
  hostDescription,
  graphLabel,
  emptyMessage,
  toolbar,
  selectedId,
  onSelectionChange,
  inspectorId,
  inspectorLabel,
  inspector,
  loading = false,
  loadingLabel,
}: {
  groups: InspectionGraphGroup[];
  hostLabel: string;
  hostDescription?: string;
  graphLabel: string;
  emptyMessage: string;
  toolbar: ReactNode;
  selectedId: string | null;
  onSelectionChange: (id: string | null) => void;
  inspectorId: string;
  inspectorLabel: string;
  inspector: ReactNode;
  loading?: boolean;
  loadingLabel?: string;
}) {
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusing, setFocusing] = useState(false);
  const [links, setLinks] = useState<{ id: string; d: string }[]>([]);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const selectionTrigger = useRef<HTMLButtonElement | null>(null);
  const wasInspecting = useRef(false);
  const backgroundPress = useRef<{
    pointerId: number;
    x: number;
    y: number;
    moved: boolean;
    empty: boolean;
  } | null>(null);
  const groupRefs = useRef(new Map<string, HTMLDivElement>());
  const panZoom = usePanZoom(viewportRef);
  const { view, setView } = panZoom;

  const selected = groups.flatMap((group) => group.items).find((item) => item.id === selectedId);

  useEffect(() => {
    if (selectedId && !selected && !loading) onSelectionChange(null);
  }, [selectedId, selected, loading, onSelectionChange]);

  const measure = useCallback(() => {
    const content = contentRef.current;
    const host = hostRef.current;
    if (!content || !host) return;
    setCanvasSize({ width: content.offsetWidth, height: content.offsetHeight });
    const hostX = host.offsetLeft + host.offsetWidth;
    const hostY = host.offsetTop + host.offsetHeight / 2;
    const next: { id: string; d: string }[] = [];
    const lastRowByColumn = new Map<number, number>();
    const firstRowByColumn = new Map<number, number>();
    const countByColumn = new Map<number, number>();
    for (const element of groupRefs.current.values()) {
      firstRowByColumn.set(
        element.offsetLeft,
        Math.min(firstRowByColumn.get(element.offsetLeft) ?? Infinity, element.offsetTop),
      );
      countByColumn.set(element.offsetLeft, (countByColumn.get(element.offsetLeft) ?? 0) + 1);
      lastRowByColumn.set(
        element.offsetLeft,
        Math.max(lastRowByColumn.get(element.offsetLeft) ?? 0, element.offsetTop),
      );
    }
    const rightmostColumn = Math.max(...lastRowByColumn.keys());
    groupRefs.current.forEach((element, id) => {
      const x = element.offsetLeft;
      const lane = x - 16;
      if (x === rightmostColumn && element.offsetTop === firstRowByColumn.get(x)) {
        // The horizontal bus ends at the top of the rightmost branch's first card.
        const center = x + element.offsetWidth / 2;
        next.push({ id, d: `M${hostX},${hostY} H${center} V${element.offsetTop}` });
      } else if (element.offsetTop === lastRowByColumn.get(x)) {
        // End the trunk in the row gutter and enter its final card from above.
        const top = element.offsetTop;
        const center = x + element.offsetWidth / 2;
        next.push({
          id,
          d:
            countByColumn.get(x) === 1
              ? `M${hostX},${hostY} H${center} V${top}`
              : `M${hostX},${hostY} H${lane} V${top - 12} H${center} V${top}`,
        });
      } else {
        const y = element.offsetTop + 20;
        next.push({ id, d: `M${hostX},${hostY} H${lane} V${y} H${x}` });
      }
    });
    setLinks(next);
  }, []);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content?.offsetWidth || !content.offsetHeight) return;
    const top = (controlsRef.current?.offsetHeight ?? 90) + 32;
    const width = Math.max(
      1,
      viewport.clientWidth - (detailRef.current?.offsetWidth ?? 0) - (detailRef.current ? 60 : 48),
    );
    const height = Math.max(1, viewport.clientHeight - top - 64);
    const scale = Math.min(1, width / content.offsetWidth, height / content.offsetHeight);
    setView({
      scale,
      x: 24 + Math.max(0, (width - content.offsetWidth * scale) / 2),
      y: top + Math.max(0, (height - content.offsetHeight * scale) / 2),
    });
  }, [setView]);

  useLayoutEffect(() => {
    measure();
    fit();
  }, [measure, fit, groups]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const resize = () => {
      measure();
      fit();
    };
    if (typeof ResizeObserver === "undefined") return observeLayoutFallback(viewport, resize);
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    if (controlsRef.current) observer.observe(controlsRef.current);
    return () => observer.disconnect();
  }, [measure, fit, groups.length]);

  useLayoutEffect(() => {
    if (!selectedId) {
      if (wasInspecting.current) {
        wasInspecting.current = false;
        setFocusing(true);
        // The inspector has unmounted, so Fit uses the full canvas again.
        fit();
      }
      return;
    }
    wasInspecting.current = true;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const node = nodeRefs.current.get(selectedId);
    if (!viewport || !content || !node?.isConnected) return;

    // Offset coordinates stay stable even when a previous camera move is in flight.
    let x = node.offsetWidth / 2;
    let y = node.offsetHeight / 2;
    let ancestor: HTMLElement | null = node;
    while (ancestor && ancestor !== content) {
      x += ancestor.offsetLeft;
      y += ancestor.offsetTop;
      ancestor = ancestor.offsetParent as HTMLElement | null;
    }
    const top = (controlsRef.current?.offsetHeight ?? 90) + 32;
    const width = Math.max(1, viewport.clientWidth - (detailRef.current?.offsetWidth ?? 0) - 60);
    const height = Math.max(1, viewport.clientHeight - top - 64);
    const scale = Math.max(
      0.01,
      Math.min(1.15, width / (node.offsetWidth + 48), height / (node.offsetHeight + 64)),
    );
    selectionTrigger.current = node;
    setFocusing(true);
    setView({ scale, x: 24 + width / 2 - x * scale, y: top + height / 2 - y * scale });
    detailRef.current?.focus({ preventScroll: true });
  }, [selectedId, selected?.id, setView, fit]);

  function closeDetail() {
    onSelectionChange(null);
    if (selectionTrigger.current?.isConnected)
      selectionTrigger.current.focus({ preventScroll: true });
  }

  function commitSelection(item: InspectionGraphItem, element: HTMLButtonElement) {
    selectionTrigger.current = element;
    if (item.id === selectedId) closeDetail();
    else onSelectionChange(item.id);
  }

  function backgroundPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    backgroundPress.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      empty: !(event.target as Element).closest(".arch-group, .arch-root"),
    };
    setFocusing(false);
    panZoom.onPointerDown(event);
  }

  function backgroundPointerMove(event: PointerEvent<HTMLDivElement>) {
    const press = backgroundPress.current;
    if (
      press?.pointerId === event.pointerId &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5
    ) {
      press.moved = true;
    }
    panZoom.onPointerMove(event);
  }

  function backgroundPointerUp(event: PointerEvent<HTMLDivElement>) {
    const press = backgroundPress.current;
    backgroundPress.current = null;
    panZoom.onPointerUp(event);
    if (press?.pointerId === event.pointerId && press.empty && !press.moved && selectedId) {
      closeDetail();
    }
  }

  function revealNode(element: HTMLButtonElement) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const node = element.getBoundingClientRect();
    const top = bounds.top + (controlsRef.current?.offsetHeight ?? 90) + 24;
    const right = bounds.right - (detailRef.current?.offsetWidth ?? 0) - 24;
    const dx =
      node.left < bounds.left + 24
        ? bounds.left + 24 - node.left
        : node.right > right
          ? right - node.right
          : 0;
    const dy =
      node.top < top
        ? top - node.top
        : node.bottom > bounds.bottom - 64
          ? bounds.bottom - 64 - node.bottom
          : 0;
    if (dx || dy) setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  }

  return (
    <div className={selected ? "arch-canvas inspecting" : "arch-canvas"}>
      <div className="ports-canvas-controls" ref={controlsRef}>
        {toolbar}
      </div>
      <GraphControls
        scale={view.scale}
        onZoom={(factor) => {
          setFocusing(false);
          panZoom.zoomBy(factor);
        }}
        onFit={() => {
          setFocusing(false);
          fit();
        }}
      />
      <div
        className="arch-viewport"
        role="region"
        ref={viewportRef}
        aria-label={graphLabel}
        onKeyDown={(event) => {
          if (event.key === "Escape" && selectedId) {
            event.stopPropagation();
            closeDetail();
          }
        }}
        onWheel={(event) => {
          setFocusing(false);
          panZoom.onWheel(event);
        }}
        onPointerDown={backgroundPointerDown}
        onPointerMove={backgroundPointerMove}
        onPointerUp={backgroundPointerUp}
        onPointerCancel={(event) => {
          backgroundPress.current = null;
          panZoom.onPointerUp(event);
        }}
      >
        {!groups.length ? (
          loadingLabel ? (
            <LoadingState label={loadingLabel} />
          ) : (
            <EmptyState title={emptyMessage} />
          )
        ) : (
          <div
            className={focusing ? "arch-content arch-focusing" : "arch-content"}
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget && event.propertyName === "transform")
                setFocusing(false);
            }}
            ref={contentRef}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          >
            <svg
              className="arch-links"
              width={canvasSize.width}
              height={canvasSize.height}
              aria-hidden="true"
            >
              {links.map((link) => (
                <path key={link.id} d={link.d} />
              ))}
            </svg>
            <div className="arch-root" ref={hostRef}>
              <Server size={18} strokeWidth={1.6} />
              <div>
                <strong>{hostLabel}</strong>
                {hostDescription && <small>{hostDescription}</small>}
              </div>
            </div>
            <div
              className="arch-column"
              style={{
                gridTemplateColumns: `repeat(${Math.min(4, Math.ceil(Math.sqrt(groups.length)))}, 248px)`,
              }}
            >
              {groups.map((group) => (
                <div
                  className={`arch-group ${group.className ?? ""}`}
                  key={group.id}
                  ref={(element) => {
                    if (element) groupRefs.current.set(group.id, element);
                    else groupRefs.current.delete(group.id);
                  }}
                >
                  <div className="arch-group-head">
                    {group.icon}
                    <span>{group.label}</span>
                  </div>
                  <div className="arch-group-ports">
                    {group.items.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        className={`arch-chip${item.id === selectedId ? " selected" : ""}`}
                        data-secondary={item.secondary || undefined}
                        aria-pressed={item.id === selectedId}
                        aria-controls={item.id === selectedId ? inspectorId : undefined}
                        ref={(element) => {
                          if (element) nodeRefs.current.set(item.id, element);
                          else nodeRefs.current.delete(item.id);
                        }}
                        onKeyDown={(event) => {
                          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                          const nodes = [...nodeRefs.current.values()];
                          const index = nodes.indexOf(event.currentTarget);
                          const next =
                            event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? nodes.length - 1
                                : Math.max(
                                    0,
                                    Math.min(
                                      nodes.length - 1,
                                      index + (event.key === "ArrowDown" ? 1 : -1),
                                    ),
                                  );
                          event.preventDefault();
                          nodes[next]?.focus();
                          if (nodes[next]) revealNode(nodes[next]);
                        }}
                        onFocus={(event) => {
                          // Pointer focus must not reveal: moving the canvas
                          // between mousedown and mouseup makes the mouseup
                          // miss the chip. Keyboard focus still reveals.
                          if (event.currentTarget.matches(":focus-visible"))
                            revealNode(event.currentTarget);
                        }}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          // Committing on press keeps selection working while
                          // the camera glide moves the chip away from the
                          // cursor before the mouseup lands. The default must
                          // go too: mousedown would otherwise focus the chip
                          // after the inspector and steal focus back.
                          event.preventDefault();
                          commitSelection(item, event.currentTarget);
                        }}
                        onClick={(event) => {
                          // Pointer presses already committed above; only
                          // keyboard activation (detail 0) still arrives here.
                          if (event.detail !== 0) return;
                          commitSelection(item, event.currentTarget);
                        }}
                      >
                        {item.content}
                        <span className="sr-only"> · {group.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {selected && (
        <aside
          id={inspectorId}
          className="detail-panel arch-detail"
          aria-label={inspectorLabel}
          tabIndex={-1}
          ref={detailRef}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              closeDetail();
            }
          }}
        >
          <button
            type="button"
            className="icon-button inspector-close"
            aria-label="Close details"
            onClick={closeDetail}
          >
            <X size={16} />
          </button>
          {inspector}
        </aside>
      )}
    </div>
  );
}
