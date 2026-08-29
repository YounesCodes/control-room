import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Plus, Search, Settings } from "lucide-react";
import { connectionTarget } from "../lib/format";
import { HostOsIcon } from "./HostOsIcon";
import type { HostCapabilities, SavedConnection, Workspace, WorkspaceView } from "../types";

type IconType = ComponentType<{ size?: number; strokeWidth?: number }>;

interface CommandItem {
  id: string;
  group: string;
  label: string;
  sublabel?: string;
  osId?: string | null;
  icon?: IconType;
  shortcut?: string;
  keywords?: string;
  run: () => void;
}

interface CommandPaletteProps {
  connections: SavedConnection[];
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeView: WorkspaceView | null;
  hasActiveConnection: boolean;
  canFocusTerminal: boolean;
  views: { id: WorkspaceView; label: string; icon: IconType }[];
  hostCapabilities: Record<string, HostCapabilities>;
  labelForWorkspace: (workspace: Workspace) => string;
  onClose: () => void;
  onOpenConnection: (connection: SavedConnection) => void;
  onSelectWorkspace: (workspace: Workspace) => void;
  onSetView: (view: WorkspaceView) => void;
  onNewTerminal: () => void;
  onReconnect: () => void;
  onCloseWorkspace: () => void;
  onFocusTerminal: () => void;
  onAddConnection: () => void;
  onOpenSettings: () => void;
}

export function CommandPalette({
  connections,
  workspaces,
  activeWorkspaceId,
  activeView,
  hasActiveConnection,
  canFocusTerminal,
  views,
  hostCapabilities,
  labelForWorkspace,
  onClose,
  onOpenConnection,
  onSelectWorkspace,
  onSetView,
  onNewTerminal,
  onReconnect,
  onCloseWorkspace,
  onFocusTerminal,
  onAddConnection,
  onOpenSettings,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<CommandItem[]>(() => {
    const result: CommandItem[] = [];
    const run = (action: () => void) => () => {
      onClose();
      action();
    };

    for (const workspace of workspaces) {
      if (workspace.id === activeWorkspaceId) continue;
      result.push({
        id: `ws-${workspace.id}`,
        group: "Open terminals",
        label: labelForWorkspace(workspace),
        sublabel: connectionTarget(workspace.connectionSnapshot),
        osId: hostCapabilities[workspace.connectionId]?.osId,
        keywords: workspace.connectionSnapshot.destination,
        run: run(() => onSelectWorkspace(workspace)),
      });
    }

    if (activeWorkspaceId) {
      for (const view of views) {
        if (view.id === activeView) continue;
        result.push({
          id: `view-${view.id}`,
          group: "Go to",
          label: view.label,
          icon: view.icon,
          run: run(() => onSetView(view.id)),
        });
      }
    }

    for (const connection of connections) {
      result.push({
        id: `conn-${connection.id}`,
        group: "Open connection",
        label: connection.displayName,
        sublabel: connectionTarget(connection),
        osId: hostCapabilities[connection.id]?.osId,
        keywords: connection.destination,
        run: run(() => onOpenConnection(connection)),
      });
    }

    result.push({
      id: "act-add",
      group: "Actions",
      label: "Add connection",
      icon: Plus,
      run: run(onAddConnection),
    });
    if (hasActiveConnection) {
      result.push({
        id: "act-new-terminal",
        group: "Actions",
        label: "New terminal",
        sublabel: "Another session for this connection",
        shortcut: "Ctrl+Shift+N",
        run: run(onNewTerminal),
      });
    }
    if (activeWorkspaceId) {
      result.push({
        id: "act-reconnect",
        group: "Actions",
        label: "Reconnect terminal",
        shortcut: "Ctrl+Shift+R",
        run: run(onReconnect),
      });
      if (canFocusTerminal) {
        result.push({
          id: "act-focus",
          group: "Actions",
          label: "Focus terminal",
          shortcut: "F11",
          run: run(onFocusTerminal),
        });
      }
      result.push({
        id: "act-close",
        group: "Actions",
        label: "Close workspace",
        shortcut: "Ctrl+Shift+W",
        run: run(onCloseWorkspace),
      });
    }
    result.push({
      id: "act-settings",
      group: "Actions",
      label: "Open settings",
      icon: Settings,
      run: run(onOpenSettings),
    });

    return result;
  }, [
    connections,
    workspaces,
    activeWorkspaceId,
    activeView,
    hasActiveConnection,
    canFocusTerminal,
    views,
    hostCapabilities,
    labelForWorkspace,
    onClose,
    onOpenConnection,
    onSelectWorkspace,
    onSetView,
    onNewTerminal,
    onReconnect,
    onCloseWorkspace,
    onFocusTerminal,
    onAddConnection,
    onOpenSettings,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      `${item.label} ${item.sublabel ?? ""} ${item.group} ${item.keywords ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [items, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
    const previousFocus = document.activeElement as HTMLElement | null;
    return () => previousFocus?.focus?.();
  }, []);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filtered]);

  function keydown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
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
      filtered[activeIndex]?.run();
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
      >
        <div className="command-palette-search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={keydown}
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
                  className={index === activeIndex ? "command-item active" : "command-item"}
                  onClick={item.run}
                  onMouseMove={() => setActiveIndex(index)}
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
                    {item.sublabel && <small>{item.sublabel}</small>}
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
