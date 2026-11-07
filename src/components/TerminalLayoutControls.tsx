import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { GripVertical, MoreHorizontal, X } from "lucide-react";
import { createPortal } from "react-dom";
import { Modal } from "./Modal";
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
  onChange: (layout: TerminalLayout) => void;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}
interface Drop {
  target: string;
  zone: TerminalDropZone;
  layout: TerminalLayout;
  valid: boolean;
  reason: string;
}
const actions = [
  ["center", "Swap"],
  ["left", "Move left"],
  ["right", "Move right"],
  ["top", "Move up"],
  ["bottom", "Move down"],
] as const;

/** Only the header captures pointers; selecting terminal text never starts a move. */
export function TerminalLayoutControls({
  layout,
  viewport,
  available,
  panes,
  container,
  labels,
  onChange,
  onActivate,
  onClose,
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
  const [menu, setMenu] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const ids = getTerminalLayoutIds(layout);
  const menuSplit = menu ? terminalParentSplitPath(layout, menu) : null;
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
    // Geometry or membership changes invalidate an in-flight pointer preview.
    const resize = () => cancel();
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("resize", resize);
    };
  }, []);
  useEffect(() => {
    cancel();
  }, [layout, viewport.width, viewport.height]);

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
    const result = current.moved ? hit(current.source, event.clientX, event.clientY) : null;
    cancel();
    if (result?.valid) onChange(result.layout);
    onActivate(current.source);
  }
  const preview =
    moving && drop ? getTerminalLayoutSurface(drop.layout, available).panes[moving] : null;
  return (
    <>
      {ids.map((id) => (
        <div
          className="terminal-pane-heading"
          data-terminal-motion-id={`${id}-heading`}
          key={id}
          style={
            getTerminalPanePixels(panes[id], viewport)
              ? {
                  left: getTerminalPanePixels(panes[id], viewport)!.left,
                  top: getTerminalPanePixels(panes[id], viewport)!.top,
                  width: getTerminalPanePixels(panes[id], viewport)!.width,
                }
              : undefined
          }
        >
          <button
            type="button"
            className="terminal-pane-grip"
            aria-label={`Move ${labels[id]}`}
            title={`Drag ${labels[id]} to swap or dock`}
            onClick={(event) => {
              if (event.detail === 0) onActivate(id);
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
              current.moved = true;
              setMoving(id);
              setDrop(hit(id, event.clientX, event.clientY));
            }}
            onPointerUp={finish}
            onPointerCancel={cancel}
            onLostPointerCapture={cancel}
          >
            <GripVertical size={13} />
            <span>{labels[id]}</span>
          </button>
          <button
            type="button"
            aria-label={`Arrange ${labels[id]}`}
            title="Arrange pane"
            onClick={() => {
              setTarget(ids.find((other) => other !== id)!);
              setMenu(id);
            }}
          >
            <MoreHorizontal size={15} />
          </button>
          <button
            type="button"
            aria-label={`Close pane ${labels[id]}`}
            title="Close pane"
            onClick={() => onClose(id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      {moving && (
        <div className="terminal-drop-layer" aria-hidden="true">
          {Object.entries(panes)
            .filter(([id]) => id !== moving)
            .map(([id, rect]) => (
              <div
                key={id}
                className={`terminal-drop-target${drop?.target === id ? (drop.valid ? " valid" : " invalid") : ""}`}
                style={getTerminalPanePixels(rect, viewport) ?? undefined}
              >
                {actions.map(([zone, name]) => (
                  <span
                    key={zone}
                    data-zone={zone}
                    className={drop?.target === id && drop.zone === zone ? "selected" : ""}
                  >
                    {name}
                  </span>
                ))}
              </div>
            ))}
          {preview && (
            <div
              className={`terminal-drop-preview${drop?.valid ? "" : " invalid"}`}
              style={getTerminalPanePixels(preview, viewport) ?? undefined}
            >
              <span>
                {labels[moving]} ·{" "}
                {drop?.valid
                  ? drop.zone === "center"
                    ? `Swap with ${labels[drop.target]}`
                    : `Dock ${drop.zone}`
                  : drop?.reason}
              </span>
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
          <Modal
            title={`Arrange ${labels[menu]}`}
            onClose={() => setMenu(null)}
            className="terminal-arrange-dialog"
          >
            <div className="terminal-arrange-body">
              <label>
                Target pane
                <select
                  aria-label="Target pane"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  {ids
                    .filter((id) => id !== menu)
                    .map((id) => (
                      <option key={id} value={id}>
                        {labels[id]}
                      </option>
                    ))}
                </select>
              </label>
              <div className="terminal-arrange-actions">
                {actions.map(([zone, name]) => (
                  <button
                    type="button"
                    key={zone}
                    disabled={!proposal(menu, target, zone).valid}
                    onClick={() => {
                      const result = proposal(menu, target, zone);
                      if (!result.valid) return;
                      onChange(result.layout);
                      setMenu(null);
                      onActivate(menu);
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <div className="terminal-arrange-actions">
                {(["vertical", "horizontal"] as const).map((direction) => (
                  <button
                    type="button"
                    key={direction}
                    aria-pressed={
                      menuSplit !== null && terminalSplitDirection(layout, menuSplit) === direction
                    }
                    title="Saved split orientation; compact windows may temporarily rotate it"
                    onClick={() => {
                      const path = terminalParentSplitPath(layout, menu);
                      if (path !== null) onChange(orientTerminalLayout(layout, path, direction));
                      setMenu(null);
                      onActivate(menu);
                    }}
                  >
                    {direction === "vertical" ? "Side by side" : "Stacked"}
                  </button>
                ))}
              </div>
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
}
