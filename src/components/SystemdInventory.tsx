import { useLayoutEffect, useRef, useState } from "react";
import { EmptyState } from "./PanelState";
import { observeLayoutFallback } from "./ResizablePanels";
import type { SystemdUnit } from "../types";

const ROW_HEIGHT = 52;
const OVERSCAN = 6;

/** Keep the inventory scrollable and keyboard navigable without mounting every unit. */
export function SystemdInventory({
  units,
  selectedId,
  onSelect,
  onExplore,
  emptyTitle,
}: {
  units: SystemdUnit[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onExplore: (id: string) => void;
  emptyTitle: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const [window, setWindow] = useState({ top: 0, height: 500 });
  const virtual = units.length > 300;
  const signature = units.map((unit) => unit.id).join("\n");
  const previousSignature = useRef(signature);
  const first = virtual ? Math.max(0, Math.floor(window.top / ROW_HEIGHT) - OVERSCAN) : 0;
  const last = virtual
    ? Math.min(units.length, Math.ceil((window.top + window.height) / ROW_HEIGHT) + OVERSCAN)
    : units.length;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWindow({ top: element.scrollTop, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return observeLayoutFallback(element, measure);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const index = units.findIndex((unit) => unit.id === selectedId);
    if (
      index >= 0 &&
      virtual &&
      (index * ROW_HEIGHT < element.scrollTop ||
        (index + 1) * ROW_HEIGHT > element.scrollTop + element.clientHeight)
    )
      element.scrollTop = index * ROW_HEIGHT;
    else if (previousSignature.current !== signature && index < 0) element.scrollTop = 0;
    previousSignature.current = signature;
    setWindow({ top: element.scrollTop, height: element.clientHeight });
  }, [signature, selectedId, virtual]);

  function focus(index: number) {
    const element = ref.current;
    const id = units[index]?.id;
    if (!element || !id) return;
    if (virtual) {
      if (index * ROW_HEIGHT < element.scrollTop) element.scrollTop = index * ROW_HEIGHT;
      else if ((index + 1) * ROW_HEIGHT > element.scrollTop + element.clientHeight)
        element.scrollTop = (index + 1) * ROW_HEIGHT - element.clientHeight;
      setWindow({ top: element.scrollTop, height: element.clientHeight });
    }
    requestAnimationFrame(() => rows.current.get(id)?.focus({ preventScroll: virtual }));
  }

  return (
    <div
      ref={ref}
      className={"dense-list" + (virtual ? " systemd-virtual-list" : "")}
      role="region"
      aria-label="Systemd units"
      tabIndex={0}
      onScroll={(event) => {
        if (virtual)
          setWindow({
            top: event.currentTarget.scrollTop,
            height: event.currentTarget.clientHeight,
          });
      }}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !units.length) return;
        event.preventDefault();
        const current = units.findIndex(
          (unit) => rows.current.get(unit.id) === document.activeElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? units.length - 1
              : Math.max(
                  0,
                  Math.min(units.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)),
                );
        focus(next);
      }}
    >
      {first > 0 && <div aria-hidden="true" style={{ height: first * ROW_HEIGHT }} />}
      {units.slice(first, last).map((unit) => (
        <button
          key={unit.id}
          type="button"
          ref={(element) => {
            if (element) rows.current.set(unit.id, element);
            else rows.current.delete(unit.id);
          }}
          className={"dense-row" + (unit.id === selectedId ? " selected-row" : "")}
          aria-pressed={unit.id === selectedId}
          title={unit.id + "\n" + unit.description}
          onClick={() => onSelect(unit.id)}
          onDoubleClick={() => onExplore(unit.id)}
        >
          <span className={"service-indicator service-" + unit.activeState} />
          <span className="row-main">
            <strong>{unit.id}</strong>
            <small>{unit.description || "No description"}</small>
          </span>
          <span className="row-state unit-row-state">
            <span>
              {unit.activeState} / {unit.subState}
            </span>
            <span className="unit-type-label">{unit.unitFileState ?? "Enablement unknown"}</span>
          </span>
        </button>
      ))}
      {last < units.length && (
        <div aria-hidden="true" style={{ height: (units.length - last) * ROW_HEIGHT }} />
      )}
      {!units.length && <EmptyState title={emptyTitle} />}
    </div>
  );
}
