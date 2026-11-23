import { useEffect, useId, useRef, useState } from "react";
import { Folder } from "lucide-react";
import { api } from "../lib/api";
import type { RemoteFolder } from "../lib/file-transfers";
import { showOverflowTitle } from "../lib/overflow-title";

const SUGGESTION_DELAY_MS = 220;
const SUGGESTION_LIMIT = 6;
const LISTING_FRESH_MS = 3000;

export function RemoteFolderPath({
  connectionId,
  folder,
  draft,
  busy,
  showHidden,
  onEdit,
  onOpen,
  onClose,
}: {
  connectionId: string;
  folder: RemoteFolder | null;
  draft: string | null;
  busy: boolean;
  showHidden: boolean;
  onEdit: (value: string | null) => void;
  onOpen: (path: string, prefetched?: RemoteFolder) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [lookup, setLookup] = useState<{
    connectionId: string;
    parent: string;
    folder: RemoteFolder;
    receivedAt: number;
  } | null>(null);
  const value = draft ?? folder?.path ?? "";
  const drivePath = /^\/?[a-z]:[/\\]/i.test(value);
  const normalized = drivePath ? "/" + value.replace(/^\//, "").replace(/\\/g, "/") : value;
  const separator = normalized.lastIndexOf("/");
  const parent =
    focused && !busy && draft !== null && value !== folder?.path && normalized.startsWith("/")
      ? normalized.slice(0, separator + 1)
      : null;
  const typedPrefix = normalized.slice(separator + 1);
  const prefix = typedPrefix.toLowerCase();
  const current = parent !== null && parent === folder?.path.replace(/\/?$/, "/") ? folder : null;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  useEffect(() => {
    if (parent === null || current) return;
    let canceled = false;
    const timer = window.setTimeout(() => {
      void api.listTransferFolder(connectionId, parent).then(
        (result) => {
          if (!canceled)
            setLookup({ connectionId, parent, folder: result, receivedAt: performance.now() });
        },
        () => {
          if (!canceled) setLookup(null);
        },
      );
    }, SUGGESTION_DELAY_MS);
    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [connectionId, current, parent]);

  const source =
    current ??
    (lookup?.connectionId === connectionId && lookup.parent === parent ? lookup.folder : null);
  const suggestions: RemoteFolder["entries"] = [];
  for (const entry of source?.entries ?? []) {
    if (
      entry.kind === "folder" &&
      (showHidden || prefix.startsWith(".") || !entry.name.startsWith(".")) &&
      entry.name.toLowerCase().startsWith(prefix)
    ) {
      suggestions.push(entry);
      if (suggestions.length === SUGGESTION_LIMIT) break;
    }
  }
  const selected = suggestions[activeIndex];
  const soleSuggestion = suggestions.length === 1 ? suggestions[0] : null;

  function openPath(path: string) {
    const prefetched =
      lookup?.connectionId === connectionId &&
      (path === lookup.parent || path === lookup.folder.path) &&
      performance.now() - lookup.receivedAt < LISTING_FRESH_MS
        ? lookup.folder
        : undefined;
    onOpen(path, prefetched);
  }

  function openSuggestion(name: string) {
    if (source) openPath(source.path.replace(/\/?$/, "/") + name);
    setActiveIndex(-1);
  }

  return (
    <form
      className="search-field file-path-field"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        if (selected) openSuggestion(selected.name);
        else if (value.trim()) openPath(value);
      }}
    >
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-label="Remote folder path"
        aria-description={
          soleSuggestion
            ? "Press Tab to complete or Enter to open the path"
            : "Press Enter to open the path"
        }
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        aria-controls={suggestions.length ? listId : undefined}
        aria-activedescendant={selected ? `${listId}-${activeIndex}` : undefined}
        placeholder="Enter a remote folder path"
        enterKeyHint="go"
        autoComplete="off"
        spellCheck={false}
        value={value}
        readOnly={busy}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setActiveIndex(-1);
          if (!busy) onEdit(null);
        }}
        onChange={(event) => {
          setActiveIndex(-1);
          onEdit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || busy) return;
          if (
            event.key === "Tab" &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            suggestions.length > 0
          ) {
            event.preventDefault();
            if (!soleSuggestion) return;
            setActiveIndex(-1);
            const delimiter =
              drivePath && value.lastIndexOf("\\") > value.lastIndexOf("/") ? "\\" : "/";
            onEdit(
              value.slice(0, value.lastIndexOf(delimiter) + 1) + soleSuggestion.name + delimiter,
            );
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (suggestions.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            const last = suggestions.length - 1;
            setActiveIndex(
              event.key === "ArrowDown"
                ? activeIndex >= last
                  ? 0
                  : activeIndex + 1
                : activeIndex <= 0
                  ? last
                  : activeIndex - 1,
            );
          }
        }}
      />
      {suggestions.length > 0 && (
        <ul
          className="file-path-suggestions"
          id={listId}
          role="listbox"
          aria-label="Remote folders"
        >
          {suggestions.map(({ name }, index) => (
            <li
              key={name}
              id={`${listId}-${index}`}
              role="option"
              aria-label={name}
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => openSuggestion(name)}
            >
              <Folder size={15} aria-hidden="true" />
              <span className="file-path-suggestion-name" onMouseEnter={showOverflowTitle}>
                {typedPrefix && <mark>{name.slice(0, typedPrefix.length)}</mark>}
                {name.slice(typedPrefix.length)}
              </span>
              {soleSuggestion && (
                <kbd className="file-path-completion-hint" aria-hidden="true">
                  Tab
                </kbd>
              )}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
