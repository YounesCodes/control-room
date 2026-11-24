import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, FileClock } from "lucide-react";
import { Search } from "./MagnifierIcon";

export interface LogSourceOption {
  id: string;
  label: string;
  detail?: string;
  journal?: boolean;
}

export function LogSourcePicker({
  label,
  placeholder,
  options,
  value,
  status,
  onChange,
}: {
  label: string;
  placeholder: string;
  options: LogSourceOption[];
  value: string;
  status?: string;
  onChange: (id: string) => void;
}) {
  const fieldId = useId();
  const listId = `${fieldId}-options`;
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<CSSProperties | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const open = placement !== null;
  const query = draft?.trim().toLowerCase() ?? "";
  const matches = query
    ? options
        .map((option) => {
          const name = option.label.toLowerCase();
          const rank = name.startsWith(query)
            ? 0
            : name.includes(query)
              ? 1
              : option.detail?.toLowerCase().includes(query) ||
                  option.id.toLowerCase().includes(query)
                ? 2
                : -1;
          return { option, rank };
        })
        .filter(({ rank }) => rank >= 0)
        .sort((a, b) => a.rank - b.rank)
        .map(({ option }) => option)
    : options;
  const active = matches.find((option) => option.id === activeId) ?? (query ? matches[0] : null);
  const selected = options.find((option) => option.id === value);
  const activeOptionId = active ? optionId(active.id) : undefined;
  const hasSuggestions = open && matches.length > 0;

  function optionId(id: string) {
    return `${listId}-${encodeURIComponent(id)}`;
  }

  function show() {
    const rect = field.current?.getBoundingClientRect();
    if (!rect) return;
    const gap = 5;
    const gutter = 12;
    const below = window.innerHeight - rect.bottom - gap - gutter;
    const above = rect.top - gap - gutter;
    const preferredHeight = 280;
    const flip = below < preferredHeight && above > below;
    const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 2 * gutter);
    setPlacement({
      left: Math.max(gutter, Math.min(rect.left, window.innerWidth - width - gutter)),
      width,
      maxHeight: Math.max(0, Math.min(preferredHeight, flip ? above : below)),
      ...(flip ? { bottom: window.innerHeight - rect.top + gap } : { top: rect.bottom + gap }),
    });
  }

  function close() {
    setPlacement(null);
    setDraft(null);
    setActiveId(null);
  }

  function choose(option: LogSourceOption) {
    onChange(option.id);
    close();
  }

  useEffect(() => {
    if (!open) return;
    const realign = (event: Event) => {
      if (event.target instanceof Element && !event.target.contains(field.current)) return;
      show();
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", realign, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", realign, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !activeOptionId || !popup.current) return;
    const option = document.getElementById(activeOptionId)?.getBoundingClientRect();
    if (!option) return;
    const bounds = popup.current.getBoundingClientRect();
    if (option.top < bounds.top) popup.current.scrollTop += option.top - bounds.top;
    if (option.bottom > bounds.bottom) popup.current.scrollTop += option.bottom - bounds.bottom;
  }, [open, activeOptionId]);

  return (
    <div className="log-source-select">
      <label htmlFor={fieldId} className="log-source-label">
        {label}
      </label>
      <div className="search-field log-source-field" ref={field}>
        <Search />
        <input
          id={fieldId}
          ref={input}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={hasSuggestions}
          aria-controls={hasSuggestions ? listId : undefined}
          aria-activedescendant={hasSuggestions ? activeOptionId : undefined}
          value={draft ?? selected?.label ?? ""}
          title={!open ? selected?.label : undefined}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onFocus={(event) => {
            event.currentTarget.select();
            show();
          }}
          onClick={(event) => {
            if (draft === null) event.currentTarget.select();
            if (!open) show();
          }}
          onBlur={close}
          onChange={(event) => {
            setDraft(event.target.value);
            setActiveId(null);
            if (!open) show();
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (event.key === "Enter" && open && active) {
              event.preventDefault();
              choose(active);
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) show();
              const index = matches.findIndex((option) => option.id === active?.id);
              const next =
                event.key === "ArrowDown"
                  ? Math.min(matches.length - 1, index + 1)
                  : index < 0
                    ? matches.length - 1
                    : Math.max(0, index - 1);
              setActiveId(matches[next]?.id ?? null);
            }
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-expanded={open}
          aria-label={open ? "Hide log sources" : "Show log sources"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (open) close();
            else {
              input.current?.focus();
              input.current?.select();
              show();
            }
          }}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
      {placement && (
        <div className="log-source-popup" ref={popup} style={placement} data-app-popover="">
          <ul
            className="log-source-list"
            id={listId}
            role="listbox"
            hidden={!matches.length}
            aria-label={`${label} suggestions`}
          >
            {matches.map((option) => (
              <li
                key={option.id}
                id={optionId(option.id)}
                role="option"
                aria-selected={option.id === (active?.id ?? value)}
                data-active={option.id === active?.id || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
                title={option.detail ? `${option.label}\n${option.detail}` : option.label}
              >
                {option.journal && <FileClock size={15} aria-hidden="true" />}
                <span className="log-source-option-text">
                  <span>{option.label}</span> {option.detail && <small>{option.detail}</small>}
                </span>
                {option.id === value && <Check size={15} aria-hidden="true" />}
              </li>
            ))}
          </ul>
          {status && (
            <p className="log-source-status" role="status">
              {status}
            </p>
          )}
          {!status && matches.length === 0 && (
            <p className="log-source-status" role="status">
              {query ? "No matching log sources." : "No log sources available."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
