import { useEffect, useRef, useState } from "react";
import { GitBranch, List, RefreshCw, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { SystemdPresence } from "./SystemdPresence";
import { Search } from "./MagnifierIcon";
import type { SystemdExplorerState } from "../types";

export function SystemdToolbar({
  state,
  total,
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
  const [tools, setTools] = useState<"search" | "filters" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const graph = state.mode === "graph";
  const search = graph ? (state.dependencySearch ?? "") : state.search;
  const filtered = state.state !== "all" || state.unitType !== "all" || state.sort !== "priority";
  useEffect(() => {
    setTools(null);
  }, [state.mode]);
  useEffect(() => {
    if (!tools) return;
    ref.current
      ?.querySelector<HTMLElement>(".systemd-tools-panel input, .systemd-tools-panel select")
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
    setTools((current) => (current === value ? null : value));
  }
  function reset() {
    onChange({ state: "all", unitType: "all", sort: "priority" });
  }
  return (
    <div className="systemd-toolbar" ref={ref}>
      <header className="systemd-heading">
        <h2 title={snapshot} tabIndex={0}>
          Systemd
        </h2>
        <span className="systemd-unit-count">{total} units</span>
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
        <div className="systemd-view-switch" role="group" aria-label="Systemd view">
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
            aria-label={selectedUnit ? "Explore " + selectedUnit : "Explore selected unit"}
            aria-current={graph && state.rootId === selectedUnit ? "page" : undefined}
            title={
              selectedUnit ? "Explore dependencies of " + selectedUnit : "Select a unit to explore"
            }
            disabled={!canGraph}
            onClick={() => onMode("graph")}
          >
            <GitBranch size={14} />
            Explore <span className="systemd-explore-unit">{selectedUnit ?? "selected unit"}</span>
          </button>
        </div>
        <SystemdPresence open={graph}>
          <div
            className="systemd-relationship-groups"
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
                onClick={() => onChange({ relationshipGroup: category })}
              >
                {category[0].toUpperCase() + category.slice(1)}
              </button>
            ))}
          </div>
        </SystemdPresence>
        <div className="systemd-toolbar-actions">
          <button
            type="button"
            className="icon-button"
            title={graph ? "Find dependencies" : "Find units"}
            aria-label={graph ? "Find dependencies" : "Find units"}
            aria-expanded={tools === "search"}
            aria-pressed={!!search}
            aria-controls="systemd-tools"
            onClick={(event) => toggle("search", event.currentTarget)}
          >
            <Search size={16} />
          </button>
          <SystemdPresence open={!graph}>
            <button
              type="button"
              className="icon-button"
              title="Filter and sort units"
              aria-label="Filter and sort units"
              aria-expanded={tools === "filters"}
              aria-pressed={filtered}
              aria-controls="systemd-tools"
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
      <SystemdPresence open={!!tools}>
        <div
          id="systemd-tools"
          className="ports-tools-panel systemd-tools-panel"
          role="region"
          aria-label={
            tools === "filters" ? "Unit filters" : graph ? "Find dependencies" : "Find units"
          }
        >
          <header className="ports-tools-heading">
            <strong>{tools === "filters" ? "Filters" : "Search"}</strong>
            {tools === "filters" && (
              <button
                type="button"
                className="icon-button"
                aria-label="Reset filters"
                disabled={!filtered}
                onClick={reset}
              >
                <RotateCcw size={14} />
              </button>
            )}
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
          {tools === "search" ? (
            <label className="search-field">
              <Search size={14} />
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
                aria-label="Clear search"
                disabled={!search}
                onClick={() => onChange(graph ? { dependencySearch: "" } : { search: "" })}
              >
                <X size={14} />
              </button>
            </label>
          ) : (
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
          )}
        </div>
      </SystemdPresence>
    </div>
  );
}
