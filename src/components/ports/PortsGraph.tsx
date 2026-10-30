import { ZoomIn, ZoomOut } from "../MagnifierIcon";
import { observeLayoutFallback } from "../ResizablePanels";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  ArrowLeftRight,
  Container,
  Cpu,
  HelpCircle,
  Scan,
  Server,
  X,
} from "lucide-react";
import { EmptyState } from "../PanelState";
import { SocketDetail } from "./SocketDetail";
import { ConnectionDetail } from "./ConnectionDetail";
import { DockerPortDetail } from "./DockerPortDetail";
import {
  buildPortGraph,
  exposureLabel,
  firewallForSocket,
  resolveSocketContainer,
  socketExposure,
  type Exposure,
  type OwnerKind,
  type PortGraphItem,
  type PortGraphKind,
  type PortSort,
} from "../../lib/port-inspector";
import { usePanZoom } from "../../lib/use-pan-zoom";
import type {
  DockerContainer,
  EstablishedConnections,
  FirewallStatus,
  HostCapabilities,
  ListeningSocket,
  LogSourceSelection,
} from "../../types";

function OwnerIcon({ kind }: { kind: OwnerKind }) {
  if (kind === "container") return <Container size={14} />;
  if (kind === "service") return <Server size={14} />;
  if (kind === "process") return <Cpu size={14} />;
  return <HelpCircle size={14} />;
}

function GraphItem({ item, firewall }: { item: PortGraphItem; firewall: FirewallStatus | null }) {
  const protocol =
    item.kind === "listeners"
      ? item.socket.protocol
      : item.kind === "connections"
        ? item.connection.protocol
        : item.binding.protocol;
  const port =
    item.kind === "listeners"
      ? item.socket.port
      : item.kind === "connections"
        ? item.connection.localPort
        : item.binding.hostPort;
  return (
    <>
      <span className="arch-chip-title">
        <span className={`protocol-mark protocol-${protocol}`}>{protocol.toUpperCase()}</span>{" "}
        <strong>{port}</strong>{" "}
        <span className="arch-chip-kind">
          {item.kind === "listeners" ? (
            "Listening"
          ) : item.kind === "connections" ? (
            <>
              <ArrowLeftRight size={13} /> {item.connection.established} established
            </>
          ) : (
            <>
              <ArrowRight size={13} /> {item.binding.containerPort}
            </>
          )}
        </span>
      </span>{" "}
      {item.kind === "listeners" && (
        <>
          <span className="arch-chip-meta technical">{item.socket.localAddress}</span>{" "}
          <span className="arch-chip-meta">
            {exposureLabel(socketExposure(item.socket.localAddress))} ·{" "}
            {firewallForSocket(firewall, item.socket).label}
          </span>
        </>
      )}
      {item.kind === "connections" && (
        <span className="arch-chip-meta">
          {item.connection.remoteAddressCount} remote addresses ·{" "}
          {item.connection.remotes[0]?.address ?? "Endpoints unavailable"}
        </span>
      )}
      {item.kind === "docker" && (
        <>
          <span className="arch-chip-meta technical">
            {item.binding.hostAddress} → {item.binding.containerPort}/{protocol}
          </span>{" "}
          <span className="arch-chip-meta">
            {[item.binding.container.composeProject, item.binding.container.composeService]
              .filter(Boolean)
              .join(" / ") || item.binding.container.image}
          </span>
        </>
      )}
    </>
  );
}

export function PortsGraph({
  sockets,
  containers,
  firewall,
  capabilities,
  hostLabel,
  connections,
  search,
  protocol,
  exposure,
  kind,
  sort,
  emptyMessage,
  toolbar,
  onOpenSystemd,
  onOpenContainer,
  onViewLogs,
}: {
  sockets: ListeningSocket[];
  containers: DockerContainer[];
  firewall: FirewallStatus | null;
  capabilities: HostCapabilities | null;
  hostLabel: string;
  connections: EstablishedConnections | null;
  search: string;
  protocol: string;
  exposure: Exposure | "all";
  kind: PortGraphKind;
  sort: PortSort;
  emptyMessage: string;
  toolbar: ReactNode;
  onOpenSystemd: (unitId: string) => void;
  onOpenContainer: (containerId: string) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [links, setLinks] = useState<{ id: string; d: string }[]>([]);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [controlsHeight, setControlsHeight] = useState(90);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const selectionTrigger = useRef<HTMLButtonElement | null>(null);
  const groupRefs = useRef(new Map<string, HTMLDivElement>());
  const panZoom = usePanZoom(viewportRef);
  const { view, setView } = panZoom;

  const groups = useMemo(
    () =>
      buildPortGraph(
        sockets,
        containers,
        connections?.groups ?? [],
        search,
        protocol,
        exposure,
        kind,
        sort,
      ),
    [sockets, containers, connections, search, protocol, exposure, kind, sort],
  );
  const selected = groups.flatMap((group) => group.items).find((item) => item.id === selectedId);

  // Filters and refreshed reads must never leave an inspector for an invisible node.
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selectedId, selected]);

  const measure = useCallback(() => {
    setControlsHeight(controlsRef.current?.offsetHeight || 90);
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
      const lane = x - 24;
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
              : `M${hostX},${hostY} H${lane} V${top - 20} H${center} V${top}`,
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

  function closeDetail() {
    setSelectedId(null);
    selectionTrigger.current?.focus({ preventScroll: true });
  }

  function backgroundPointerDown(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    panZoom.onPointerDown(event);
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

  const osLabel = [capabilities?.osName, capabilities?.osVersion].filter(Boolean).join(" ");

  return (
    <div
      className={`arch-canvas${selected ? " inspecting" : ""}`}
      style={{ "--ports-controls-height": `${controlsHeight}px` } as CSSProperties}
    >
      <div className="ports-canvas-controls" ref={controlsRef}>
        {toolbar}
      </div>
      <div className="graph-toolbar" role="toolbar" aria-label="Graph controls">
        <button
          type="button"
          className="icon-button"
          aria-label="Zoom out"
          onClick={() => panZoom.zoomBy(1 / 1.2)}
        >
          <ZoomOut size={15} />
        </button>
        <span className="zoom-level">{Math.round(view.scale * 100)}%</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Zoom in"
          onClick={() => panZoom.zoomBy(1.2)}
        >
          <ZoomIn size={15} />
        </button>
        <button type="button" className="icon-button" aria-label="Fit to view" onClick={fit}>
          <Scan size={15} />
        </button>
      </div>
      <div
        className="arch-viewport"
        role="region"
        ref={viewportRef}
        aria-label="Ports graph"
        onWheel={panZoom.onWheel}
        onPointerDown={backgroundPointerDown}
        onPointerMove={panZoom.onPointerMove}
        onPointerUp={panZoom.onPointerUp}
        onPointerCancel={panZoom.onPointerUp}
      >
        {!groups.length ? (
          <EmptyState title={emptyMessage} />
        ) : (
          <div
            className="arch-content"
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
                {osLabel && <small>{osLabel}</small>}
              </div>
            </div>
            <div
              className="arch-column"
              style={{
                gridTemplateColumns: `repeat(${Math.min(3, Math.ceil(Math.sqrt(groups.length)))}, 280px)`,
              }}
            >
              {groups.map((group) => (
                <div
                  className={`arch-group owner-${group.owner.kind}`}
                  key={group.key}
                  ref={(element) => {
                    if (element) groupRefs.current.set(group.key, element);
                    else groupRefs.current.delete(group.key);
                  }}
                >
                  <div className="arch-group-head">
                    <OwnerIcon kind={group.owner.kind} />
                    <span>{group.owner.label}</span>
                  </div>
                  <div className="arch-group-ports">
                    {group.items.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        className={`arch-chip${item.id === selectedId ? " selected" : ""}`}
                        aria-pressed={item.id === selectedId}
                        aria-controls={item.id === selectedId ? "port-inspector" : undefined}
                        onFocus={(event) => revealNode(event.currentTarget)}
                        onClick={(event) => {
                          selectionTrigger.current = event.currentTarget;
                          setSelectedId(item.id);
                          requestAnimationFrame(() => {
                            if (selectionTrigger.current?.isConnected)
                              revealNode(selectionTrigger.current);
                            detailRef.current?.focus({ preventScroll: true });
                          });
                        }}
                      >
                        <GraphItem item={item} firewall={firewall} />
                        <span className="sr-only"> · {group.owner.label}</span>
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
          id="port-inspector"
          className="detail-panel arch-detail"
          aria-label="Port details"
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
          {selected.kind === "listeners" && (
            <SocketDetail
              socket={selected.socket}
              containerOwner={resolveSocketContainer(selected.socket, containers)}
              firewall={firewall}
              onOpenSystemd={onOpenSystemd}
              onOpenContainer={onOpenContainer}
              onViewLogs={onViewLogs}
            />
          )}
          {selected.kind === "connections" && (
            <ConnectionDetail
              selected={selected.connection}
              onOpenSystemd={onOpenSystemd}
              onViewLogs={onViewLogs}
            />
          )}
          {selected.kind === "docker" && (
            <DockerPortDetail
              selected={selected.binding}
              onOpenContainer={onOpenContainer}
              onViewLogs={onViewLogs}
            />
          )}
        </aside>
      )}
    </div>
  );
}
