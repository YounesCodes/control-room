import { useLayoutEffect, useRef, useState } from "react";
import { EmptyState } from "./PanelState";
import { observeLayoutFallback } from "./ResizablePanels";
import type { SystemdExplorerState, SystemdUnit } from "../types";
import { systemdStateLabel } from "../lib/systemd-units";

const ROW_HEIGHT = 44;
const OVERSCAN = 6;

/** Keep the inventory scrollable and keyboard navigable without mounting every unit. */
export function SystemdInventory({
  units,
  selectedId,
  onSelect,
  onNavigate,
  emptyTitle,
  scope = "focused",
}: {
  units: SystemdUnit[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNavigate: (id: string) => void;
  emptyTitle: string;
  scope?: SystemdExplorerState["scope"];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const previousScope = useRef(scope);
  const scopeAnimation = useRef<Animation | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const [window, setWindow] = useState({ top: 0, height: 500 });
  const virtual = units.length > 300;
  const signature = units.map((unit) => unit.id).join("\n");
  const selectedIndex = units.findIndex((unit) => unit.id === selectedId);
  const previousSelection = useRef({ signature, index: selectedIndex });
  const glide =
    previousSelection.current.signature === signature &&
    previousSelection.current.index >= 0 &&
    Math.abs(selectedIndex - previousSelection.current.index) <
      Math.ceil(window.height / ROW_HEIGHT);
  useLayoutEffect(() => {
    previousSelection.current = { signature, index: selectedIndex };
  }, [signature, selectedIndex]);
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
      (index * ROW_HEIGHT < element.scrollTop ||
        (index + 1) * ROW_HEIGHT > element.scrollTop + element.clientHeight)
    )
      element.scrollTop =
        index * ROW_HEIGHT < element.scrollTop
          ? index * ROW_HEIGHT
          : (index + 1) * ROW_HEIGHT - element.clientHeight;
    else if (previousSignature.current !== signature && index < 0) element.scrollTop = 0;
    previousSignature.current = signature;
    setWindow({ top: element.scrollTop, height: element.clientHeight });
  }, [signature, selectedId, virtual]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const row = rows.current.get(pendingFocus.current);
    if (!row) {
      if (!units.some((unit) => unit.id === pendingFocus.current)) pendingFocus.current = null;
      return;
    }
    pendingFocus.current = null;
    row.focus({ preventScroll: true });
  });
  useLayoutEffect(() => {
    if (previousScope.current === scope) return;
    previousScope.current = scope;
    const element = content.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const interrupted = scopeAnimation.current?.playState === "running";
    // Retarget from the rendered pose when the user switches back mid-reveal.
    const from = {
      opacity: interrupted ? style.opacity : style.getPropertyValue("--scope-opacity").trim(),
      transform: interrupted
        ? style.transform
        : `translateY(${style.getPropertyValue("--scope-offset").trim()})`,
    };
    scopeAnimation.current?.cancel();
    if (typeof element.animate !== "function") return;
    scopeAnimation.current = element.animate([from, { opacity: 1, transform: "translateY(0)" }], {
      duration: parseFloat(style.getPropertyValue("--motion-slow")),
      easing: style.getPropertyValue("--ease").trim(),
    });
  }, [scope]);
  useLayoutEffect(() => () => scopeAnimation.current?.cancel(), []);

  function focus(index: number, select: boolean) {
    const element = ref.current;
    const id = units[index]?.id;
    if (!element || !id) return;
    if (index * ROW_HEIGHT < element.scrollTop) element.scrollTop = index * ROW_HEIGHT;
    else if ((index + 1) * ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = (index + 1) * ROW_HEIGHT - element.clientHeight;
    pendingFocus.current = id;
    setWindow({ top: element.scrollTop, height: element.clientHeight });
    if (select) onNavigate(id);
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
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !units.length) return;
        event.preventDefault();
        event.stopPropagation();
        const focused = units.findIndex(
          (unit) => rows.current.get(unit.id) === document.activeElement,
        );
        const current = focused >= 0 ? focused : units.findIndex((unit) => unit.id === selectedId);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? units.length - 1
              : Math.max(
                  0,
                  Math.min(
                    units.length - 1,
                    current < 0
                      ? event.key === "ArrowDown"
                        ? 0
                        : units.length - 1
                      : current + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                );
        focus(next, event.key === "ArrowUp" || event.key === "ArrowDown");
      }}
    >
      <div className="systemd-inventory-rows" ref={content}>
        {selectedIndex >= 0 && (
          <div
            className="systemd-selection-indicator"
            aria-hidden="true"
            data-glide={glide || undefined}
            style={{ transform: `translateY(${selectedIndex * ROW_HEIGHT}px)` }}
          />
        )}
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
          >
            <span className="row-main">
              <strong>{unit.id}</strong>
              <small>{unit.description || "No description"}</small>
            </span>
            <span className="row-state unit-row-state">
              <span
                className={"service-indicator service-" + unit.activeState}
                aria-hidden="true"
              />
              <span>{systemdStateLabel(unit.activeState, unit.subState)}</span>
            </span>
          </button>
        ))}
        {last < units.length && (
          <div aria-hidden="true" style={{ height: (units.length - last) * ROW_HEIGHT }} />
        )}
        {!units.length && <EmptyState title={emptyTitle} />}
      </div>
    </div>
  );
}
