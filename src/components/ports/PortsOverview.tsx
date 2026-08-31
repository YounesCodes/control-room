import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  Boxes,
  Cpu,
  HelpCircle,
  Maximize2,
  Minimize2,
  Scan,
  Server,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { EmptyState } from "../PanelState";
import { SocketDetail } from "./SocketDetail";
import {
  exposureLabel,
  firewallForSocket,
  groupSocketsByOwner,
  resolveSocketContainer,
  socketExposure,
  type OwnerGroup,
  type OwnerKind,
} from "../../lib/port-inspector";
import { usePanZoom } from "../../lib/use-pan-zoom";
import { reconcileSelection } from "../../lib/workspace-cache";
import type {
  DockerContainer,
  FirewallStatus,
  HostCapabilities,
  ListeningSocket,
  LogSourceSelection,
} from "../../types";

function OwnerIcon({ kind }: { kind: OwnerKind }) {
  if (kind === "container") return <Boxes size={14} />;
  if (kind === "service") return <Server size={14} />;
  if (kind === "process") return <Cpu size={14} />;
  return <HelpCircle size={14} />;
}

interface Link {
  id: string;
  d: string;
}

export function PortsOverview({
  sockets,
  containers,
  firewall,
  capabilities,
  hostLabel,
  onOpenSystemd,
  onOpenContainer,
  onViewLogs,
}: {
  sockets: ListeningSocket[];
  containers: DockerContainer[];
  firewall: FirewallStatus | null;
  capabilities: HostCapabilities | null;
  hostLabel: string;
  onOpenSystemd: (unitId: string) => void;
  onOpenContainer: (containerId: string) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    reconcileSelection(sockets, null),
  );
  const [fullscreen, setFullscreen] = useState(false);
  const [links, setLinks] = useState<Link[]>([]);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const canvasRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const groupRefs = useRef(new Map<string, HTMLDivElement>());

  const panZoom = usePanZoom(viewportRef);
  const { view, setView } = panZoom;

  const groups: OwnerGroup[] = groupSocketsByOwner(sockets, containers);

  useEffect(() => {
    setSelectedId((current) => reconcileSelection(sockets, current));
  }, [sockets]);

  const measure = useCallback(() => {
    const content = contentRef.current;
    const host = hostRef.current;
    if (!content || !host) return;
    setCanvasSize({ width: content.offsetWidth, height: content.offsetHeight });
    // Fan out from the host's right edge to each owner box's left edge with a
    // smooth horizontal S-curve.
    const hostX = host.offsetLeft + host.offsetWidth;
    const hostY = host.offsetTop + host.offsetHeight / 2;
    const next: Link[] = [];
    groupRefs.current.forEach((element, key) => {
      const groupX = element.offsetLeft;
      const groupY = element.offsetTop + element.offsetHeight / 2;
      const controlX = hostX + (groupX - hostX) / 2;
      next.push({
        id: key,
        d: `M${hostX},${hostY} C${controlX},${hostY} ${controlX},${groupY} ${groupX},${groupY}`,
      });
    });
    setLinks(next);
  }, []);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const contentWidth = content.offsetWidth;
    const contentHeight = content.offsetHeight;
    if (!contentWidth || !contentHeight) return;
    const padding = 48;
    const scale = Math.max(
      0.3,
      Math.min(
        1,
        (viewport.clientWidth - padding) / contentWidth,
        (viewport.clientHeight - padding) / contentHeight,
      ),
    );
    const x = Math.max(24, (viewport.clientWidth - contentWidth * scale) / 2);
    const y = Math.max(24, (viewport.clientHeight - contentHeight * scale) / 2);
    setView({ scale, x, y });
  }, [setView]);

  useLayoutEffect(() => {
    measure();
  }, [measure, sockets, containers]);

  // Fit whenever the graph is (re)built for a new host or socket set.
  useLayoutEffect(() => {
    fit();
  }, [fit, sockets.length, groups.length]);

  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  useEffect(() => {
    const onChange = () => {
      setFullscreen(document.fullscreenElement === canvasRef.current);
      window.setTimeout(fit, 0);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [fit]);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void canvasRef.current?.requestFullscreen?.();
    }
  }

  function backgroundPointerDown(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    panZoom.onPointerDown(event);
  }

  const selected = sockets.find((socket) => socket.id === selectedId) ?? null;
  const selectedContainer = selected ? resolveSocketContainer(selected, containers) : null;
  const osLabel = [capabilities?.osName, capabilities?.osVersion].filter(Boolean).join(" ");

  return (
    <div className={`ports-view arch-view${fullscreen ? " fullscreen" : ""}`}>
      <div className="arch-canvas" ref={canvasRef}>
        <div className="graph-toolbar">
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
          <button
            type="button"
            className="icon-button"
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>

        {sockets.length === 0 ? (
          <EmptyState title="No listening ports match the current filters" />
        ) : (
          <div
            className="arch-viewport"
            ref={viewportRef}
            onWheel={panZoom.onWheel}
            onPointerDown={backgroundPointerDown}
            onPointerMove={panZoom.onPointerMove}
            onPointerUp={panZoom.onPointerUp}
          >
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

              <div className="arch-column">
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
                      {group.sockets.map((socket) => {
                        const disposition = firewallForSocket(firewall, socket);
                        const isSelected = socket.id === selectedId;
                        return (
                          <button
                            type="button"
                            key={socket.id}
                            className={`arch-chip${isSelected ? " selected" : ""}`}
                            aria-pressed={isSelected}
                            onClick={() => setSelectedId(socket.id)}
                          >
                            <span className="arch-chip-title">
                              <span className={`protocol-mark protocol-${socket.protocol}`}>
                                {socket.protocol.toUpperCase()}
                              </span>
                              <strong>{socket.port}</strong>
                            </span>
                            <span className="arch-chip-meta">
                              {exposureLabel(socketExposure(socket.localAddress))}
                            </span>
                            {disposition.state !== "unavailable" && (
                              <span className="arch-chip-meta faint">{disposition.label}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <aside className="detail-panel arch-detail">
        {selected ? (
          <SocketDetail
            socket={selected}
            containerOwner={selectedContainer}
            firewall={firewall}
            onOpenSystemd={onOpenSystemd}
            onOpenContainer={onOpenContainer}
            onViewLogs={onViewLogs}
          />
        ) : (
          <EmptyState title="Select a port or service" />
        )}
      </aside>
    </div>
  );
}
