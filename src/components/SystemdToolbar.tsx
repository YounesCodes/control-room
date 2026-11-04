import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { GitBranch, List, RefreshCw, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { SystemdPresence } from "./SystemdPresence";
import { Search } from "./MagnifierIcon";
import type { SystemdExplorerState } from "../types";
import { SYSTEMD_INITIAL_VISIBLE } from "../lib/systemd-units";

function useSwitchFill(selection: string, layout: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef(selection);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (previous.current !== selection) element.dataset.animated = "true";
    previous.current = selection;
    const measure = () => {
      const active = element.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      if (!active) return;
      element.style.setProperty("--view-fill-x", active.offsetLeft + "px");
      element.style.setProperty("--view-fill-width", active.offsetWidth + "px");
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.querySelectorAll("button").forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [selection, layout]);
  return ref;
}

export function SystemdToolbar({
  state,
  total,
  visible,
  failed,
  snapshot,
  loading,
  canGraph,
  selectedUnit,
  types,
  states,
  onChange,
  onMode,
  onRefresh,
}: {
  state: SystemdExplorerState;
  total: number;
  visible: number;
  failed: number;
  snapshot: string;
  loading: boolean;
  canGraph: boolean;
  selectedUnit: string | null;
  types: string[];
  states: string[];
  onChange: (patch: Partial<SystemdExplorerState>) => void;
  onMode: (mode: SystemdExplorerState["mode"]) => void;
  onRefresh: () => void;
}) {
  const [tools, setToolsState] = useState<"search" | "filters" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const viewSwitch = useSwitchFill(state.mode, selectedUnit);
  const categorySwitch = useSwitchFill(state.relationshipGroup, state.mode);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const searchField = useRef<HTMLDivElement>(null);
  const resizeFrom = useRef<{ heading: DOMRect; items: Map<HTMLElement, DOMRect> } | null>(null);
  const resizeAnimations = useRef<Animation[]>([]);
  function stopResize() {
    resizeAnimations.current.forEach((animation) => animation.cancel());
    resizeAnimations.current = [];
    ref.current?.querySelector(".systemd-heading")?.removeAttribute("data-resizing");
  }
  function setTools(next: "search" | "filters" | null, animateLayout = true) {
    if (animateLayout && (tools === "search") !== (next === "search")) {
      const heading = ref.current?.querySelector<HTMLElement>(".systemd-heading");
      if (heading)
        resizeFrom.current = {
          heading: heading.getBoundingClientRect(),
          items: new Map(
            [...heading.children].map((item) => [
              item as HTMLElement,
              item.getBoundingClientRect(),
            ]),
          ),
        };
    }
    if (next === "search" && tools !== "search" && searchField.current) {
      const field = searchField.current;
      field.style.setProperty("--search-enter-width", field.getBoundingClientRect().width + "px");
      field.style.setProperty("--search-enter-opacity", getComputedStyle(field).opacity);
    }
    if (tools === "search" && next !== "search" && searchField.current) {
      const field = searchField.current;
      field.style.setProperty("--search-exit-width", field.getBoundingClientRect().width + "px");
      field.style.setProperty("--search-exit-opacity", getComputedStyle(field).opacity);
    }
    setToolsState(next);
  }
  const filterTrigger = useRef<HTMLButtonElement>(null);
  const filterPanel = useRef<HTMLDivElement>(null);
  const graph = state.mode === "graph";
  const search = graph ? (state.dependencySearch ?? "") : state.search;
  const filtered = state.state !== "all" || state.unitType !== "all" || state.sort !== "priority";
  useEffect(() => {
    setTools(null, false);
  }, [state.mode]);
  useLayoutEffect(() => {
    const from = resizeFrom.current;
    resizeFrom.current = null;
    stopResize();
    const heading = ref.current?.querySelector<HTMLElement>(".systemd-heading");
    if (
      !from ||
      !heading ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
      !heading.animate
    )
      return;
    const style = getComputedStyle(heading);
    const duration = parseFloat(style.getPropertyValue("--search-layout-duration"));
    if (!duration) return;
    const bounds = heading.getBoundingClientRect();
    const items = [...heading.children].map((item) => ({
      element: item as HTMLElement,
      bounds: item.getBoundingClientRect(),
    }));
    const timing = {
      duration,
      easing: style.getPropertyValue("--search-layout-ease").trim(),
      fill: "both" as const,
    };
    // Move and resize the real boxes without scaling text. Restore normal flex
    // layout when all controls settle, or capture these rendered boxes on reversal.
    heading.dataset.resizing = "true";
    const animations = [
      heading.animate(
        [{ height: from.heading.height + "px" }, { height: bounds.height + "px" }],
        timing,
      ),
    ];
    for (const item of items) {
      const before = from.items.get(item.element) ?? item.bounds;
      const pose = (rect: DOMRect, parent: DOMRect) => ({
        left: rect.left - parent.left - heading.clientLeft + "px",
        top: rect.top - parent.top - heading.clientTop + "px",
        width: rect.width + "px",
        minWidth: rect.width + "px",
        maxWidth: rect.width + "px",
        height: rect.height + "px",
      });
      animations.push(
        item.element.animate([pose(before, from.heading), pose(item.bounds, bounds)], timing),
      );
    }
    resizeAnimations.current = animations;
    void Promise.all(animations.map((animation) => animation.finished))
      .then(() => {
        if (resizeAnimations.current === animations) stopResize();
      })
      .catch(() => {});
  }, [tools]);
  useLayoutEffect(() => {
    stopResize();
    resizeFrom.current = null;
  }, [state.mode, selectedUnit]);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    window.addEventListener("resize", stopResize);
    media?.addEventListener("change", stopResize);
    return () => {
      window.removeEventListener("resize", stopResize);
      media?.removeEventListener("change", stopResize);
      stopResize();
    };
  }, []);
  useLayoutEffect(() => {
    if (tools !== "filters") return;
    const position = () => {
      const toolbar = ref.current,
        icon = filterTrigger.current,
        panel = filterPanel.current;
      if (!toolbar || !icon || !panel) return;
      const bounds = toolbar.getBoundingClientRect();
      const anchor = icon.getBoundingClientRect();
      const width = Math.min(330, Math.max(0, bounds.width - 24));
      panel.style.width = width + "px";
      panel.style.left =
        Math.max(12, Math.min(anchor.right - bounds.left - width, bounds.width - width - 12)) +
        "px";
      const top = Math.max(anchor.bottom + 8, bounds.bottom + 6);
      panel.style.top = top - bounds.top + "px";
      panel.style.maxHeight = Math.max(80, window.innerHeight - top - 12) + "px";
    };
    position();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    if (ref.current) observer?.observe(ref.current);
    if (filterTrigger.current) observer?.observe(filterTrigger.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [tools]);
  useEffect(() => {
    if (!tools) return;
    ref.current
      ?.querySelector<HTMLElement>(
        tools === "search" ? ".systemd-inline-search input" : ".systemd-tools-panel select",
      )
      ?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) setTools(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setTools(null);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [tools]);
  function toggle(value: "search" | "filters", button: HTMLButtonElement) {
    trigger.current = button;
    setTools(tools === value ? null : value);
  }
  function reset() {
    onChange({ state: "all", unitType: "all", sort: "priority" });
  }
  return (
    <div
      className="systemd-toolbar"
      ref={ref}
      data-mode={state.mode}
      data-search-open={tools === "search" || undefined}
    >
      <header className="systemd-heading">
        <h2 title={snapshot} tabIndex={0}>
          Systemd
        </h2>
        <span
          className="systemd-unit-count"
          title={visible + " units in inventory; " + total + " collected"}
        >
          {visible !== total ? visible + " / " + total + " units" : total + " units"}
        </span>
        {failed > 0 && (
          <button
            type="button"
            className="systemd-failures"
            title="Show failed units"
            onClick={() => {
              onChange({ state: "failed", unitType: "all", search: "" });
              onMode("inventory");
            }}
          >
            {failed} failed
          </button>
        )}
        <div
          className="systemd-view-switch systemd-mode-switch"
          ref={viewSwitch}
          role="group"
          aria-label="Systemd view"
        >
          <button
            type="button"
            aria-label="Explorer"
            aria-pressed={!graph}
            title="Unit inventory"
            onClick={() => onMode("inventory")}
          >
            <List size={14} />
            Explorer
          </button>
          <button
            type="button"
            aria-pressed={graph}
            title={
              selectedUnit
                ? "Show relationships for " + selectedUnit
                : "Select a unit to view its relationships"
            }
            disabled={!canGraph}
            onClick={() => onMode("graph")}
          >
            <GitBranch size={14} />
            Relationships{" "}
            {selectedUnit && (
              <>
                <span aria-hidden="true">·</span>
                <span className="systemd-unit-target">{selectedUnit}</span>
              </>
            )}
          </button>
        </div>
        <div className="systemd-mode-tools">
          <SystemdPresence open={!graph}>
            <div
              className="systemd-scope-switch systemd-view-switch"
              role="group"
              aria-label="Unit scope"
            >
              <button
                type="button"
                aria-pressed={state.scope !== "all"}
                title="Services, timers, sockets, and paths, excluding routine system units. Failed units always appear. Search includes all units."
                onClick={() => onChange({ scope: "focused" })}
              >
                Focused
              </button>
              <button
                type="button"
                aria-pressed={state.scope === "all"}
                title="Include every unit type and system service"
                onClick={() => onChange({ scope: "all" })}
              >
                All units
              </button>
            </div>
          </SystemdPresence>
          <SystemdPresence open={graph}>
            <div
              className="systemd-relationship-groups systemd-mode-switch"
              ref={categorySwitch}
              role="group"
              aria-label="Relationship category"
            >
              {(["dependencies", "ordering", "activation"] as const).map((category) => (
                <button
                  key={category}
                  type="button"
                  aria-pressed={state.relationshipGroup === category}
                  title={
                    category === "dependencies"
                      ? "Requires and Wants, including reverse dependencies"
                      : category === "ordering"
                        ? "Before and After ordering constraints"
                        : "Triggers and TriggeredBy activation evidence"
                  }
                  onClick={() =>
                    onChange({ relationshipGroup: category, visibleLimit: SYSTEMD_INITIAL_VISIBLE })
                  }
                >
                  {category[0].toUpperCase() + category.slice(1)}
                </button>
              ))}
            </div>
          </SystemdPresence>
        </div>
        <div className="systemd-toolbar-actions">
          <div className="systemd-search-control search-field">
            <button
              type="button"
              className="icon-button"
              title={graph ? "Find dependencies" : "Find units"}
              aria-label={graph ? "Find dependencies" : "Find units"}
              aria-expanded={tools === "search"}
              aria-pressed={!!search}
              aria-controls="systemd-search"
              onClick={(event) => toggle("search", event.currentTarget)}
            >
              <Search size={16} />
            </button>
            <SystemdPresence open={tools === "search"}>
              <div
                ref={searchField}
                id="systemd-search"
                className="systemd-inline-search"
                role="region"
                aria-label={graph ? "Find dependencies" : "Find units"}
              >
                <input
                  aria-label={graph ? "Search dependencies" : "Search units"}
                  placeholder={graph ? "Search dependencies" : "Search units"}
                  value={search}
                  onChange={(event) =>
                    onChange(
                      graph
                        ? { dependencySearch: event.target.value }
                        : { search: event.target.value },
                    )
                  }
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={search ? "Clear search" : "Hide search"}
                  title={search ? "Clear search" : "Hide search"}
                  onClick={() => {
                    if (search) {
                      onChange(graph ? { dependencySearch: "" } : { search: "" });
                      searchField.current?.querySelector("input")?.focus();
                    } else {
                      setTools(null);
                      trigger.current?.focus();
                    }
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            </SystemdPresence>
          </div>
          <SystemdPresence open={!graph}>
            <button
              type="button"
              className="icon-button"
              ref={filterTrigger}
              title="Filter and sort units"
              aria-label="Filter and sort units"
              aria-expanded={tools === "filters"}
              aria-pressed={filtered}
              aria-controls="systemd-filters"
              onClick={(event) => toggle("filters", event.currentTarget)}
            >
              <SlidersHorizontal size={16} />
            </button>
          </SystemdPresence>
          <button
            type="button"
            className="icon-button"
            title="Refresh systemd units"
            aria-label="Refresh systemd units"
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw size={16} className={loading ? "spinning" : ""} />
          </button>
        </div>
      </header>
      <SystemdPresence open={tools === "filters"}>
        <div
          ref={filterPanel}
          id="systemd-filters"
          className="ports-tools-panel systemd-tools-panel"
          role="region"
          aria-label="Unit filters"
        >
          <header className="ports-tools-heading">
            <strong>Filters</strong>
            <button
              type="button"
              className="icon-button"
              aria-label="Reset filters"
              disabled={!filtered}
              onClick={reset}
            >
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Close unit tools"
              onClick={() => {
                setTools(null);
                trigger.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          </header>
          <div className="systemd-filter-fields">
            <label>
              State
              <select
                aria-label="Unit state"
                value={state.state}
                onChange={(event) => onChange({ state: event.target.value })}
              >
                <option value="all">All states</option>
                {states.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              Type
              <select
                aria-label="Unit type"
                value={state.unitType}
                onChange={(event) => onChange({ unitType: event.target.value })}
              >
                <option value="all">All types</option>
                {types.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              Sort
              <select
                aria-label="Sort units"
                value={state.sort}
                onChange={(event) =>
                  onChange({ sort: event.target.value as SystemdExplorerState["sort"] })
                }
              >
                <option value="priority">Failed first</option>
                <option value="name">Name</option>
                <option value="state">State</option>
                <option value="type">Type</option>
              </select>
            </label>
          </div>
        </div>
      </SystemdPresence>
    </div>
  );
}
