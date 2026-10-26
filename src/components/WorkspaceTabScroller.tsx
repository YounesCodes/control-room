import { Children, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { usePopoverExit } from "../hooks/use-popover-exit";

export interface WorkspaceTabOption {
  id: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  active: boolean;
  onSelect: () => void;
}

interface WorkspaceTabScrollerProps {
  children: ReactNode;
  items: WorkspaceTabOption[];
  activeTabId: string | null;
  arrangementKey: string;
  menuLabel?: string;
}

const MIN_TAB_WIDTH = 160;
const MAX_TAB_WIDTH = 196;
const OVERFLOW_CONTROLS_WIDTH = 84;

export function WorkspaceTabScroller({
  children,
  items,
  activeTabId,
  arrangementKey,
  menuLabel = "All terminals",
}: WorkspaceTabScrollerProps) {
  const regionRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [start, setStart] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const { present: menuPresent, closing: menuClosing } = usePopoverExit(menuOpen);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, maxHeight: 0 });
  const tabs = Children.toArray(children);
  const count = tabs.length;
  const overflow = width > 0 && count * MIN_TAB_WIDTH > width;
  const available = Math.max(0, width - (overflow ? OVERFLOW_CONTROLS_WIDTH : 0));
  const pageSize =
    width > 0 ? Math.max(1, Math.min(count, Math.floor(available / MIN_TAB_WIDTH))) : count;
  const tabWidth =
    width > 0 ? Math.min(MAX_TAB_WIDTH, available / Math.max(1, pageSize)) : MAX_TAB_WIDTH;
  const lastStart = Math.max(0, count - pageSize);
  const visibleStart = overflow ? Math.min(start, lastStart) : 0;
  const activeIndex = items.findIndex((item) => item.active);

  useEffect(() => setMenuOpen(false), [arrangementKey, overflow]);

  useLayoutEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const measure = () => setWidth(region.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    setStart((current) => {
      const bounded = Math.min(current, lastStart);
      if (!activeTabId || activeIndex < 0) return bounded;
      if (activeIndex < bounded) return activeIndex;
      if (activeIndex >= bounded + pageSize) return Math.min(lastStart, activeIndex - pageSize + 1);
      return bounded;
    });
  }, [activeTabId, activeIndex, arrangementKey, pageSize, lastStart]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !regionRef.current?.contains(event.target))
        setMenuOpen(false);
    };
    const closeOnResize = () => setMenuOpen(false);
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("resize", closeOnResize);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen || !pickerRef.current || !menuRef.current) return;
    const anchor = pickerRef.current.getBoundingClientRect();
    const menuWidth = Math.min(360, window.innerWidth - 16);
    const gap = 6;
    const below = window.innerHeight - anchor.bottom - gap - 8;
    const above = anchor.top - gap - 8;
    const useAbove = below < 128 && above > below;
    const maxHeight = Math.min(480, Math.max(0, useAbove ? above : below));
    const height = Math.min(menuRef.current.scrollHeight, maxHeight);
    setMenuPosition({
      left: Math.max(8, Math.min(anchor.right - menuWidth, window.innerWidth - menuWidth - 8)),
      top: useAbove ? Math.max(8, anchor.top - height - gap) : anchor.bottom + gap,
      maxHeight,
    });
    menuRef.current.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
    if (!menuRef.current.contains(document.activeElement))
      menuRef.current.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menuOpen]);

  function move(direction: -1 | 1) {
    setStart((current) =>
      Math.max(0, Math.min(lastStart, current + direction * Math.max(1, pageSize))),
    );
  }

  function closeMenu() {
    setMenuOpen(false);
    pickerRef.current?.focus();
  }

  useEffect(() => {
    const list = listRef.current;
    if (!list || !overflow) return;
    let accumulated = 0;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const wheel = (event: WheelEvent) => {
      const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const delta =
        raw * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? list.clientWidth : 1);
      if (!delta) return;
      event.preventDefault();
      if (Math.sign(accumulated) !== Math.sign(delta)) accumulated = 0;
      accumulated += delta;
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        accumulated = 0;
      }, 120);
      if (Math.abs(accumulated) < 80) return;
      accumulated = 0;
      setStart((current) =>
        Math.max(0, Math.min(lastStart, current + (delta > 0 ? 1 : -1) * pageSize)),
      );
    };
    list.addEventListener("wheel", wheel, { passive: false });
    return () => {
      list.removeEventListener("wheel", wheel);
      clearTimeout(resetTimer);
    };
  }, [overflow, lastStart, pageSize]);

  return (
    <div className="session-tab-scroll-region" ref={regionRef}>
      {overflow && (
        <button
          className="session-tab-scroll-button"
          type="button"
          disabled={visibleStart === 0}
          onClick={() => move(-1)}
          aria-label="Scroll terminals left"
          title="Previous terminals"
        >
          <ChevronLeft size={15} />
        </button>
      )}
      <div className="session-tab-list" ref={listRef} data-tauri-drag-region>
        <div
          className="session-tab-content"
          data-tauri-drag-region
          style={{ "--session-tab-width": `${tabWidth}px` } as React.CSSProperties}
        >
          {tabs.slice(visibleStart, visibleStart + pageSize)}
        </div>
      </div>
      {overflow && (
        <>
          <button
            className="session-tab-scroll-button"
            type="button"
            disabled={visibleStart === lastStart}
            onClick={() => move(1)}
            aria-label="Scroll terminals right"
            title="Next terminals"
          >
            <ChevronRight size={15} />
          </button>
          <button
            ref={pickerRef}
            className="session-tab-scroll-button session-tab-picker"
            type="button"
            aria-label={menuLabel}
            title={`${menuLabel} (${count})`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((current) => !current)}
          >
            <ChevronDown size={15} />
          </button>
        </>
      )}
      {overflow && menuPresent && (
        <div
          ref={menuRef}
          className="session-tab-overflow-menu"
          role="menu"
          aria-label={menuLabel}
          style={menuPosition}
          aria-hidden={menuClosing || undefined}
          inert={menuClosing || undefined}
          data-closing={menuClosing || undefined}
          data-app-popover=""
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
              }
              closeMenu();
              return;
            }
            const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
            if (!keys.includes(event.key)) return;
            event.preventDefault();
            const buttons = [
              ...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
            ];
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                    buttons.length;
            buttons[next]?.focus();
          }}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              role="menuitem"
              type="button"
              aria-current={item.active ? "page" : undefined}
              onClick={() => {
                closeMenu();
                setStart((current) =>
                  index < current || index >= current + pageSize
                    ? Math.min(index, lastStart)
                    : current,
                );
                item.onSelect();
              }}
            >
              {item.icon && (
                <span className="session-tab-menu-icon" aria-hidden="true">
                  {item.icon}
                </span>
              )}
              <span className="session-tab-menu-name">
                {item.label}
                {item.detail && <small>{item.detail}</small>}
              </span>
              <span className="session-tab-menu-check" aria-hidden="true">
                {item.active && <Check size={14} />}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
