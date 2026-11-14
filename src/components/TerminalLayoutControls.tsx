import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Columns2, Rows2 } from "lucide-react";
import { createPortal } from "react-dom";
import {
  getTerminalPanePixels,
  getTerminalLayoutIds,
  getTerminalLayoutSurface,
  orientTerminalLayout,
  rearrangeTerminalLayout,
  terminalDropZone,
  terminalLayoutFits,
  terminalParentSplitPath,
  terminalSplitDirection,
  type TerminalLayout,
  type TerminalLayoutViewport,
  type TerminalDropZone,
  type TerminalPaneRect,
} from "../lib/terminal-layout";

interface Props {
  layout: TerminalLayout;
  viewport: TerminalLayoutViewport;
  available: TerminalLayoutViewport;
  panes: Record<string, TerminalPaneRect>;
  container: RefObject<HTMLDivElement | null>;
  labels: Record<string, string>;
  /** Identity marks (shell logo or host OS) shown in the Arrange map. */
  marks?: Record<string, ReactNode>;
  onChange: (layout: TerminalLayout) => void;
  onActivate: (id: string) => void;
}
interface Drop {
  target: string;
  zone: TerminalDropZone;
  layout: TerminalLayout;
  valid: boolean;
  reason: string;
}

const zones: TerminalDropZone[] = ["center", "left", "right", "top", "bottom"];

const dropCaption: Record<TerminalDropZone, (target: string) => string> = {
  center: (target) => `Swap with ${target}`,
  left: (target) => `Dock left of ${target}`,
  right: (target) => `Dock right of ${target}`,
  top: (target) => `Dock above ${target}`,
  bottom: (target) => `Dock below ${target}`,
};

const ARRANGE_WIDTH = 288;
const ARRANGE_MAP_WIDTH = 264;
const POPOVER_GAP = 6;
const POPOVER_GUTTER = 8;

/** Inset a surface percentage rectangle so neighboring map tiles keep a gutter. */
function tileStyle(rect: TerminalPaneRect): CSSProperties {
  return {
    left: `calc(${rect.left}% + 2px)`,
    top: `calc(${rect.top}% + 2px)`,
    width: `calc(${rect.width}% - 4px)`,
    height: `calc(${rect.height}% - 4px)`,
  };
}

function arrangeMapHeight(viewport: TerminalLayoutViewport) {
  const ratio =
    viewport.width > 0 && Number.isFinite(viewport.height / viewport.width)
      ? viewport.height / viewport.width
      : 0.6;
  return Math.round(Math.min(176, Math.max(104, ARRANGE_MAP_WIDTH * ratio)));
}

/**
 * Each pane carries a small frosted grip in its top-right corner, shown on hover.
 * Dragging it moves the pane; clicking it opens Arrange, a live map of the group where
 * each pane's center swaps and its edges dock, previewed before anything changes.
 * Only the grip captures pointers; selecting terminal text never starts a move.
 */
export function TerminalLayoutControls({
  layout,
  viewport,
  available,
  panes,
  container,
  labels,
  marks = {},
  onChange,
  onActivate,
}: Props) {
  const [moving, setMoving] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const pointer = useRef<{
    id: number;
    source: string;
    x: number;
    y: number;
    handle: HTMLButtonElement;
    moved: boolean;
  } | null>(null);
  const [menu, setMenu] = useState<{ id: string; style: CSSProperties } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const grips = useRef(new Map<string, HTMLButtonElement>());
  const ids = getTerminalLayoutIds(layout);
  function cancel() {
    const current = pointer.current;
    pointer.current = null;
    if (current?.handle.hasPointerCapture?.(current.id))
      current.handle.releasePointerCapture(current.id);
    setMoving(null);
    setDrop(null);
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && pointer.current) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    document.addEventListener("keydown", keydown, true);
    // Geometry or membership changes invalidate an in-flight preview or an open map.
    const resize = () => {
      cancel();
      setMenu(null);
    };
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("resize", resize);
    };
  }, []);
  useEffect(() => {
    cancel();
  }, [layout, viewport.width, viewport.height]);
  // Reveal a pane's grip while the pointer is over that pane, without a header strip.
  useEffect(() => {
    const surface = container.current;
    if (!surface) return;
    const move = (event: PointerEvent) => {
      const bounds = surface.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const x = ((event.clientX - bounds.left) / bounds.width) * 100;
      const y = ((event.clientY - bounds.top) / bounds.height) * 100;
      const id =
        Object.entries(panes).find(
          ([, rect]) =>
            x >= rect.left &&
            x < rect.left + rect.width &&
            y >= rect.top &&
            y < rect.top + rect.height,
        )?.[0] ?? null;
      setHovered((current) => (current === id ? current : id));
    };
    const leave = () => setHovered(null);
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerleave", leave);
    return () => {
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerleave", leave);
    };
  }, [container, panes]);

  function openArrange(id: string) {
    if (menu?.id === id) {
      setMenu(null);
      return;
    }
    const rect = grips.current.get(id)?.getBoundingClientRect();
    if (!rect) return;
    const height = arrangeMapHeight(viewport) + 112;
    const left = Math.max(
      POPOVER_GUTTER,
      Math.min(
        rect.left + rect.width / 2 - ARRANGE_WIDTH / 2,
        window.innerWidth - ARRANGE_WIDTH - POPOVER_GUTTER,
      ),
    );
    const below = window.innerHeight - rect.bottom - POPOVER_GAP - POPOVER_GUTTER;
    setMenu({
      id,
      style:
        below >= height || rect.top < height
          ? { left, top: rect.bottom + POPOVER_GAP }
          : { left, bottom: window.innerHeight - rect.top + POPOVER_GAP },
    });
  }
  function closeArrange(returnFocus: boolean) {
    const id = menu?.id;
    setMenu(null);
    if (returnFocus && id) grips.current.get(id)?.focus();
  }

  function proposal(source: string, destination: string, zone: TerminalDropZone): Drop {
    const next = rearrangeTerminalLayout(layout, source, destination, zone);
    const geometry = getTerminalLayoutSurface(next, available);
    const a = geometry.panes[source];
    const b = geometry.panes[destination];
    const placement =
      a &&
      b &&
      (zone === "center" ||
        (zone === "left" && a.left + a.width <= b.left + 0.01) ||
        (zone === "right" && b.left + b.width <= a.left + 0.01) ||
        (zone === "top" && a.top + a.height <= b.top + 0.01) ||
        (zone === "bottom" && b.top + b.height <= a.top + 0.01));
    return {
      target: destination,
      zone,
      layout: next,
      reason: next === layout ? "Already here" : "Not enough room",
      valid:
        next !== layout &&
        !!placement &&
        (zone === "center" || terminalLayoutFits(next, available)),
    };
  }
  function hit(source: string, clientX: number, clientY: number): Drop | null {
    const bounds = container.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
    const x = ((clientX - bounds.left) / bounds.width) * 100;
    const y = ((clientY - bounds.top) / bounds.height) * 100;
    for (const [id, rect] of Object.entries(panes)) {
      if (id === source) continue;
      const zone = terminalDropZone((x - rect.left) / rect.width, (y - rect.top) / rect.height);
      if (zone) return proposal(source, id, zone);
    }
    return null;
  }
  function finish(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = pointer.current;
    if (!current || current.id !== event.pointerId) return;
    if (!current.moved) {
      cancel();
      openArrange(current.source);
      return;
    }
    const result = hit(current.source, event.clientX, event.clientY);
    cancel();
    if (result?.valid) onChange(result.layout);
    onActivate(current.source);
  }
  const preview =
    moving && drop ? getTerminalLayoutSurface(drop.layout, available).panes[moving] : null;
  return (
    <>
      {ids.map((id) => {
        const rect = getTerminalPanePixels(panes[id], viewport);
        const engaged = moving === id || menu?.id === id;
        const revealed = moving ? moving === id : hovered === id || engaged;
        return (
          <div
            className={[
              "terminal-pane-heading",
              revealed ? "revealed" : "",
              engaged ? "engaged" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-terminal-motion-id={`${id}-heading`}
            key={id}
            style={rect ? { left: rect.left, top: rect.top, width: rect.width } : undefined}
          >
            <button
              ref={(element) => {
                if (element) grips.current.set(id, element);
                else grips.current.delete(id);
              }}
              type="button"
              className="terminal-pane-grip"
              aria-label={`Arrange ${labels[id]}`}
              aria-haspopup="dialog"
              aria-expanded={menu?.id === id}
              title="Drag to move, click to arrange"
              onClick={(event) => {
                // Pointer clicks are handled on pointerup so a drag never also opens Arrange.
                if (event.detail === 0) openArrange(id);
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || !event.isPrimary) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                pointer.current = {
                  id: event.pointerId,
                  source: id,
                  x: event.clientX,
                  y: event.clientY,
                  handle: event.currentTarget,
                  moved: false,
                };
              }}
              onPointerMove={(event) => {
                const current = pointer.current;
                if (!current || current.id !== event.pointerId) return;
                if (
                  !current.moved &&
                  Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5
                )
                  return;
                if (!current.moved) setMenu(null);
                current.moved = true;
                setMoving(id);
                setDrop(hit(id, event.clientX, event.clientY));
              }}
              onPointerUp={finish}
              onPointerCancel={cancel}
              onLostPointerCapture={cancel}
            >
              <span className="terminal-pane-grip-dots" aria-hidden="true">
                {Array.from({ length: 6 }, (_, index) => (
                  <i key={index} />
                ))}
              </span>
            </button>
          </div>
        );
      })}
      {moving && (
        // One preview of the result replaces per-zone labels: the shape shows where the
        // pane lands and a single caption names the move.
        <div className="terminal-drop-layer" aria-hidden="true">
          <div
            className="terminal-drop-source"
            style={getTerminalPanePixels(panes[moving], viewport) ?? undefined}
          />
          {drop && !drop.valid && (
            <div
              className="terminal-drop-target invalid"
              style={getTerminalPanePixels(panes[drop.target], viewport) ?? undefined}
            >
              <span>{drop.reason}</span>
            </div>
          )}
          {drop?.valid && preview && (
            <div
              className="terminal-drop-preview"
              style={getTerminalPanePixels(preview, viewport) ?? undefined}
            >
              <span>{dropCaption[drop.zone](labels[drop.target])}</span>
            </div>
          )}
        </div>
      )}
      <span className="sr-only" role="status">
        {moving
          ? drop
            ? drop.valid
              ? `${labels[moving]}: ${drop.zone === "center" ? "swap" : `dock ${drop.zone}`} with ${labels[drop.target]}`
              : "Cannot move here"
            : "Choose a pane center to swap or an edge to dock. Escape cancels."
          : ""}
      </span>
      {menu &&
        createPortal(
          <ArrangePopover
            source={menu.id}
            style={menu.style}
            layout={layout}
            viewport={viewport}
            available={available}
            panes={panes}
            labels={labels}
            marks={marks}
            grip={grips.current.get(menu.id) ?? null}
            proposal={proposal}
            onApply={(next) => {
              onChange(next);
              setMenu(null);
              onActivate(menu.id);
            }}
            onClose={closeArrange}
          />,
          document.body,
        )}
    </>
  );
}

interface ArrangeProps {
  source: string;
  style: CSSProperties;
  layout: TerminalLayout;
  viewport: TerminalLayoutViewport;
  available: TerminalLayoutViewport;
  panes: Record<string, TerminalPaneRect>;
  labels: Record<string, string>;
  marks: Record<string, ReactNode>;
  grip: HTMLButtonElement | null;
  proposal: (source: string, target: string, zone: TerminalDropZone) => Drop;
  onApply: (layout: TerminalLayout) => void;
  onClose: (returnFocus: boolean) => void;
}

/**
 * Arrange as a map rather than a form: the group in miniature, with this pane marked
 * as the one moving. Pointing at (or focusing) another pane's center or an edge
 * previews the result in place and names it; choosing it applies the move.
 */
function ArrangePopover({
  source,
  style,
  layout,
  viewport,
  available,
  panes,
  labels,
  marks,
  grip,
  proposal,
  onApply,
  onClose,
}: ArrangeProps) {
  const root = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState<Drop | null>(null);
  const split = terminalParentSplitPath(layout, source);
  const direction = split === null ? null : terminalSplitDirection(layout, split);
  const result = pick?.valid
    ? getTerminalLayoutSurface(pick.layout, available).panes[source]
    : null;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    root.current?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || root.current?.contains(target) || grip?.contains(target)) return;
      onCloseRef.current(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [grip]);

  return (
    <div
      ref={root}
      className="terminal-arrange-menu"
      role="dialog"
      aria-label={`Arrange ${labels[source]}`}
      tabIndex={-1}
      style={style}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      }}
    >
      <div
        className="terminal-arrange-map"
        style={{ height: arrangeMapHeight(viewport) }}
        onPointerLeave={() => setPick(null)}
      >
        {Object.entries(panes).map(([id, rect]) => (
          <div
            key={id}
            className={id === source ? "terminal-arrange-tile source" : "terminal-arrange-tile"}
            style={tileStyle(rect)}
          >
            <span className="terminal-arrange-tile-name" aria-hidden="true">
              {marks[id]}
              <span>{labels[id]}</span>
            </span>
            {id !== source &&
              zones.map((zone) => {
                const option = proposal(source, id, zone);
                const name = dropCaption[zone](labels[id]);
                return (
                  <button
                    key={zone}
                    type="button"
                    className="terminal-arrange-zone"
                    data-zone={zone}
                    data-state={
                      option.valid ? "valid" : option.reason === "Already here" ? "same" : "invalid"
                    }
                    aria-label={option.valid ? name : `${name}: ${option.reason.toLowerCase()}`}
                    aria-disabled={!option.valid || undefined}
                    onPointerEnter={() => setPick(option)}
                    onFocus={() => setPick(option)}
                    onBlur={() => setPick(null)}
                    onClick={() => {
                      if (option.valid) onApply(option.layout);
                    }}
                  />
                );
              })}
          </div>
        ))}
        {result && (
          <div className="terminal-arrange-result" style={tileStyle(result)} aria-hidden="true" />
        )}
      </div>
      <p
        className={
          pick && !pick.valid ? "terminal-arrange-caption unavailable" : "terminal-arrange-caption"
        }
        aria-hidden="true"
      >
        {pick
          ? pick.valid
            ? dropCaption[pick.zone](labels[pick.target])
            : pick.reason
          : "Center swaps, edges dock"}
      </p>
      {split !== null && (
        <div className="terminal-arrange-orientation" role="group" aria-label="Split orientation">
          {(["vertical", "horizontal"] as const).map((option) => (
            <button
              type="button"
              key={option}
              aria-pressed={direction === option}
              onClick={() => {
                if (direction !== option) onApply(orientTerminalLayout(layout, split, option));
                else onClose(true);
              }}
            >
              {option === "vertical" ? <Columns2 size={14} /> : <Rows2 size={14} />}
              {option === "vertical" ? "Side by side" : "Stacked"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
