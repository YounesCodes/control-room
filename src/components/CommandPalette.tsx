import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { RegisteredAction } from "../lib/action-registry";
import { HostOsIcon } from "./HostOsIcon";

interface CommandPaletteProps {
  actions: RegisteredAction[];
  onClose: () => void;
}

export function CommandPalette({ actions, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((item) =>
      `${item.label} ${item.sublabel ?? ""} ${item.group} ${item.keywords ?? ""} ${item.disabledReason ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [actions, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previousFocus?.focus?.();
  }, []);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, filtered]);

  function execute(action: RegisteredAction | undefined) {
    if (!action || action.disabledReason) return;
    onClose();
    action.run();
  }

  function inputKeydown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (filtered.length ? (index + 1) % filtered.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) =>
        filtered.length ? (index - 1 + filtered.length) % filtered.length : 0,
      );
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, filtered.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      execute(filtered[activeIndex]);
    }
  }

  function dialogKeydown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...event.currentTarget.querySelectorAll<HTMLElement>("input, button, [tabindex]"),
    ].filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  let renderedGroup: string | null = null;

  return (
    <div className="command-palette-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={dialogKeydown}
      >
        <div className="command-palette-search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={inputKeydown}
            placeholder="Search connections, views, and actions…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-listbox"
            aria-activedescendant={filtered[activeIndex]?.id}
            aria-autocomplete="list"
            spellCheck={false}
          />
        </div>
        <div
          className="command-palette-list"
          ref={listRef}
          id="command-palette-listbox"
          role="listbox"
        >
          {filtered.length === 0 && <p className="command-palette-empty">No matching commands</p>}
          {filtered.map((item, index) => {
            const showGroup = item.group !== renderedGroup;
            renderedGroup = item.group;
            const Icon = item.icon;
            return (
              <div key={item.id}>
                {showGroup && (
                  <div className="command-group-label" role="presentation">
                    {item.group}
                  </div>
                )}
                <button
                  type="button"
                  id={item.id}
                  role="option"
                  aria-selected={index === activeIndex}
                  aria-disabled={item.disabledReason ? "true" : undefined}
                  className={[
                    "command-item",
                    index === activeIndex ? "active" : "",
                    item.disabledReason ? "disabled" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => execute(item)}
                  onMouseMove={() => setActiveIndex(index)}
                  title={item.disabledReason}
                >
                  {item.osId !== undefined ? (
                    <HostOsIcon osId={item.osId} />
                  ) : Icon ? (
                    <Icon size={16} strokeWidth={1.8} />
                  ) : (
                    <span className="host-os-icon" aria-hidden="true" />
                  )}
                  <span className="command-item-body">
                    <strong>{item.label}</strong>
                    {(item.disabledReason || item.sublabel) && (
                      <small>{item.disabledReason ?? item.sublabel}</small>
                    )}
                  </span>
                  {item.shortcut && (
                    <span className="command-shortcut">
                      {item.shortcut.split("+").map((part) => (
                        <kbd key={part}>{part}</kbd>
                      ))}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <div className="command-palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>↵</kbd> Select
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </div>
      </div>
    </div>
  );
}
