import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
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
  /// Moves tab `id` to `targetIndex`, expressed in whole-strip positions.
  /// Absent rejects reordering: group rows and the pane strip pass none.
  onReorder?: (id: string, targetIndex: number) => void;
}

const MIN_TAB_WIDTH = 160;
const MAX_TAB_WIDTH = 196;
const OVERFLOW_CONTROLS_WIDTH = 84;
/// A pointer this far from its origin counts as a drag, not a tab click.
const DRAG_START_PX = 4;
/// Holding the lifted tab this close to an overflowing strip's edge pages the window.
const DRAG_EDGE_PX = 28;
const DRAG_STEP_MS = 350;

interface DragGeometry {
  tabWidth: number;
  /// How far into the tab the pointer went down, so the tab follows the same
  /// point of the cursor for the whole drag.
  grabOffset: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface PendingDrag {
  pointerId: number;
  id: string;
  fromIndex: number;
  startX: number;
  startY: number;
  geometry: DragGeometry;
}

interface ActiveDrag {
  pointerId: number;
  id: string;
  fromIndex: number;
  pointerX: number;
  geometry: DragGeometry;
}

/// Tabs sit at a uniform `geometry.tabWidth`, so the slot under the lifted
/// tab's center is the drop target, clamped to the strip's ends.
function dragTargetFrom(drag: ActiveDrag, sliceStart: number, total: number) {
  const { geometry } = drag;
  const center = drag.pointerX - geometry.grabOffset + geometry.tabWidth / 2;
  const steps = Math.round((center - geometry.left) / geometry.tabWidth - 0.5);
  return Math.max(sliceStart, Math.min(total - 1, sliceStart + steps));
}

export function WorkspaceTabScroller({
  children,
  items,
  activeTabId,
  arrangementKey,
  menuLabel = "All terminals",
  onReorder,
}: WorkspaceTabScrollerProps) {
  const regionRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
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
  const pendingDragRef = useRef<PendingDrag | null>(null);
  const activeDragRef = useRef<ActiveDrag | null>(null);
  const [dragging, setDragging] = useState<ActiveDrag | null>(null);
  const frameRef = useRef<number | null>(null);
  const pointerXRef = useRef<number | null>(null);
  const dragScrollRef = useRef<{ direction: -1 | 0 | 1; timer: number | null }>({
    direction: 0,
    timer: null,
  });
  const clickGuardRef = useRef<(() => void) | null>(null);

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

  function stopDragScroll() {
    const { timer } = dragScrollRef.current;
    dragScrollRef.current = { direction: 0, timer: null };
    if (timer !== null) window.clearInterval(timer);
  }

  /// Holding the pointer at an overflowing strip's edge reveals the tabs beyond
  /// the window one at a time, so any tab can reach the first or last position.
  function steerDragScroll(x: number, geometry: DragGeometry) {
    if (!overflow) {
      stopDragScroll();
      return;
    }
    const direction: -1 | 0 | 1 =
      x < geometry.left + DRAG_EDGE_PX ? -1 : x > geometry.right - DRAG_EDGE_PX ? 1 : 0;
    if (direction === dragScrollRef.current.direction) return;
    stopDragScroll();
    if (!direction) return;
    const timer = window.setInterval(() => {
      setStart((current) => Math.max(0, Math.min(lastStart, current + direction)));
    }, DRAG_STEP_MS);
    dragScrollRef.current = { direction, timer };
  }

  function flushDragFrame() {
    frameRef.current = null;
    const active = activeDragRef.current;
    if (!active) return;
    const x = pointerXRef.current;
    pointerXRef.current = null;
    if (x === null) return;
    const next = { ...active, pointerX: x };
    activeDragRef.current = next;
    setDragging(next);
    steerDragScroll(x, next.geometry);
  }

  function finishDrag() {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    pointerXRef.current = null;
    stopDragScroll();
    pendingDragRef.current = null;
    activeDragRef.current = null;
    setDragging(null);
    disarmClickSuppression();
  }

  const finishDragRef = useRef(finishDrag);
  finishDragRef.current = finishDrag;
  const stopDragScrollRef = useRef(stopDragScroll);
  stopDragScrollRef.current = stopDragScroll;

  /// A dragged tab would still receive the click that follows its pointerup,
  /// selecting it against the drag's own promise. One capture-phase swallow
  /// eats exactly that click; the next macrotask disarms it for later clicks.
  function armClickSuppression() {
    if (clickGuardRef.current) return;
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    clickGuardRef.current = () => window.removeEventListener("click", swallow, true);
  }

  function disarmClickSuppression() {
    const disarm = clickGuardRef.current;
    if (!disarm) return;
    clickGuardRef.current = null;
    window.setTimeout(disarm, 0);
  }

  // While a tab is lifted, Escape gives the motion one clear way out, and a
  // release the strip never sees (a WebView without pointer capture, an
  // interrupted gesture) ends the drag instead of leaving it mid-air.
  useEffect(() => {
    if (!dragging) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finishDragRef.current();
    };
    const abandon = () => finishDragRef.current();
    window.addEventListener("keydown", cancel, true);
    window.addEventListener("pointerup", abandon);
    window.addEventListener("pointercancel", abandon);
    return () => {
      window.removeEventListener("keydown", cancel, true);
      window.removeEventListener("pointerup", abandon);
      window.removeEventListener("pointercancel", abandon);
    };
  }, [dragging]);

  // The strip going away mid-motion still schedules rAF frames, paging timers,
  // and the click guard through its refs; release them once on teardown.
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      stopDragScrollRef.current();
      clickGuardRef.current?.();
      clickGuardRef.current = null;
    },
    [],
  );

  /// Resolves the strip tab a pointer or keyboard event acts on: only the main
  /// tab button begins or moves a reorder, never Rename, Close, or the edges.
  function tabFromEvent(target: EventTarget | null) {
    const handle = (target as Element | null)?.closest(
      ".session-tab-main, .session-tab-group-main",
    );
    const content = contentRef.current;
    const tab = handle?.closest<HTMLElement>(".session-tab-wrap, .session-tab-group");
    if (!content || !tab || !content.contains(tab)) return null;
    const index = Array.prototype.indexOf.call(content.children, tab);
    if (index < 0) return null;
    return { index, tab };
  }

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!onReorder || count < 2 || activeDragRef.current || pendingDragRef.current) return;
    if (event.button !== 0 || !event.isPrimary) return;
    const content = contentRef.current;
    const hit = tabFromEvent(event.target);
    if (!content || !hit) return;
    const rect = hit.tab.getBoundingClientRect();
    const bounds = content.getBoundingClientRect();
    if (rect.width < 1 || bounds.width < 1) return;
    const fromIndex = visibleStart + hit.index;
    const id = items[fromIndex]?.id;
    if (!id) return;
    // Capture is taken when the drag activates, not here: a pointerdown
    // capture would retarget the plain click that selects a tab.
    pendingDragRef.current = {
      pointerId: event.pointerId,
      id,
      fromIndex,
      startX: event.clientX,
      startY: event.clientY,
      geometry: {
        tabWidth: rect.width,
        grabOffset: event.clientX - rect.left,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
      },
    };
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const active = activeDragRef.current;
    if (active && active.pointerId === event.pointerId) {
      event.preventDefault();
      pointerXRef.current = event.clientX;
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(flushDragFrame);
      return;
    }
    const pending = pendingDragRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    const dx = event.clientX - pending.startX;
    const dy = event.clientY - pending.startY;
    // Nothing changes below the threshold, so a plain tab click never reads
    // as the start of a drag.
    if (dx * dx + dy * dy < DRAG_START_PX * DRAG_START_PX) return;
    event.preventDefault();
    const content = contentRef.current;
    try {
      content?.setPointerCapture(event.pointerId);
    } catch {
      // Without capture the drag still tracks inside the strip; the window
      // pointerup fallback in the drag effect ends it outside.
    }
    armClickSuppression();
    activeDragRef.current = {
      pointerId: pending.pointerId,
      id: pending.id,
      fromIndex: pending.fromIndex,
      pointerX: event.clientX,
      geometry: pending.geometry,
    };
    pendingDragRef.current = null;
    setDragging(activeDragRef.current);
    steerDragScroll(event.clientX, activeDragRef.current.geometry);
  }

  function releaseDrag(event: ReactPointerEvent<HTMLDivElement>) {
    pendingDragRef.current = null;
    const active = activeDragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    finishDrag();
    if (!onReorder) return;
    const { geometry } = active;
    // Dropping outside the strip rearranges nothing.
    const inside =
      event.clientX >= geometry.left &&
      event.clientX <= geometry.right &&
      event.clientY >= geometry.top &&
      event.clientY <= geometry.bottom;
    if (!inside) return;
    const sliceStart = Math.min(visibleStart, active.fromIndex);
    const target = dragTargetFrom({ ...active, pointerX: event.clientX }, sliceStart, count);
    if (target !== active.fromIndex) onReorder(active.id, target);
  }

  /// Ctrl+Shift with an arrow key moves the focused tab one slot, the keyboard
  /// path to the same reorder a drag performs.
  function reorderWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!onReorder || count < 2 || activeDragRef.current) return;
    if (!event.ctrlKey || !event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const hit = tabFromEvent(event.target);
    if (!hit) return;
    const fromIndex = visibleStart + hit.index;
    const target = event.key === "ArrowLeft" ? fromIndex - 1 : fromIndex + 1;
    if (target < 0 || target >= count) return;
    const id = items[fromIndex]?.id;
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    onReorder(id, target);
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

  const activeDrag = dragging;
  // While a tab is lifted, every rendered tab is pinned absolutely, so the
  // window can reach beyond the page for the drag without resizing others.
  const dragSliceStart = activeDrag ? Math.min(visibleStart, activeDrag.fromIndex) : visibleStart;
  const dragTarget = activeDrag ? dragTargetFrom(activeDrag, dragSliceStart, count) : null;
  const renderedTabs = activeDrag
    ? tabs.slice(dragSliceStart, Math.max(visibleStart + pageSize, activeDrag.fromIndex + 1))
    : tabs.slice(visibleStart, visibleStart + pageSize);

  return (
    <div
      className={[
        "session-tab-scroll-region",
        onReorder ? "can-reorder" : "",
        activeDrag ? "dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={regionRef}
    >
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
          ref={contentRef}
          data-tauri-drag-region
          onPointerDown={onReorder ? beginDrag : undefined}
          onPointerMove={onReorder ? moveDrag : undefined}
          onPointerUp={onReorder ? releaseDrag : undefined}
          onPointerCancel={onReorder ? finishDrag : undefined}
          onLostPointerCapture={onReorder ? finishDrag : undefined}
          onKeyDown={onReorder ? reorderWithKeyboard : undefined}
          style={{ "--session-tab-width": `${tabWidth}px` } as React.CSSProperties}
        >
          {renderedTabs.map((tab, index) => {
            const slotIndex = dragSliceStart + index;
            if (!activeDrag || !isValidElement(tab)) return tab;
            const element = tab as ReactElement<{ className?: string; style?: CSSProperties }>;
            const geometry = activeDrag.geometry;
            const classes = [element.props.className ?? ""];
            const style: CSSProperties = {
              ...element.props.style,
              position: "absolute",
              left: (slotIndex - dragSliceStart) * geometry.tabWidth,
              top: 0,
              bottom: 0,
              width: geometry.tabWidth,
            };
            if (slotIndex === activeDrag.fromIndex) {
              classes.push("session-tab-dragged");
              style.zIndex = 30;
              style.transform = `translate3d(${activeDrag.pointerX - geometry.grabOffset - geometry.left - (activeDrag.fromIndex - dragSliceStart) * geometry.tabWidth}px, 0, 0)`;
            } else if (dragTarget !== null && dragTarget !== activeDrag.fromIndex) {
              // The tabs between the lift and the drop slide one slot against
              // the drag's direction, opening the gap the drop fills.
              const slides =
                dragTarget < activeDrag.fromIndex
                  ? slotIndex >= dragTarget && slotIndex < activeDrag.fromIndex
                  : slotIndex > activeDrag.fromIndex && slotIndex <= dragTarget;
              if (slides) {
                classes.push("session-tab-shifted");
                style.transform = `translate3d(${dragTarget < activeDrag.fromIndex ? geometry.tabWidth : -geometry.tabWidth}px, 0, 0)`;
              }
            }
            return cloneElement(element, {
              className: classes.filter(Boolean).join(" "),
              style,
            });
          })}
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
