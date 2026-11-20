import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
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
import { flushSync } from "react-dom";
import { ChevronLeft, ChevronRight, GalleryVerticalEnd, X } from "lucide-react";
import { usePopoverExit } from "../hooks/use-popover-exit";

export type WorkspaceTabKind = "local" | "remote" | "group";

export interface WorkspaceTabOption {
  id: string;
  label: string;
  detail?: string;
  status?: string;
  attention?: boolean;
  kind?: WorkspaceTabKind;
  icon?: ReactNode;
  active: boolean;
  onSelect: () => void;
  onClose?: () => void;
}

const MENU_SECTIONS: { kind: WorkspaceTabKind; label: string }[] = [
  { kind: "local", label: "Local shells" },
  { kind: "remote", label: "Connections" },
  { kind: "group", label: "Groups" },
];
const MENU_FILTER_MIN_ITEMS = 8;

function splitTrailingNumber(label: string): [string, string] {
  const match = /^(.*\S)(\s+\d+)$/.exec(label);
  return match ? [match[1], match[2]] : [label, ""];
}

export function TabLabel({ label }: { label: string }) {
  const [base, suffix] = splitTrailingNumber(label);
  if (!suffix) return <span className="session-tab-label">{label}</span>;
  return (
    <span
      className="session-tab-label"
      style={{ "--tab-label-suffix-width": `${suffix.length}ch` } as CSSProperties}
    >
      <span className="session-tab-label-base">{base}</span>
      <span className="session-tab-label-suffix">{suffix}</span>
    </span>
  );
}

function focusMenuRow(row: HTMLElement) {
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
}

function menuButtonTitle(label: string, hidden: number, attention: boolean) {
  if (!hidden) return label;
  return `${label}: ${hidden} not in the tab row${attention ? ", one needs attention" : ""}`;
}

interface WorkspaceTabScrollerProps {
  children: ReactNode;
  items: WorkspaceTabOption[];
  activeTabId: string | null;
  arrangementKey: string;
  menuLabel?: string;
  menuAlwaysShown?: boolean;
  trailing?: ReactNode;
  onReorder?: (id: string, targetIndex: number) => void;
  reorderModifier?: "control" | "meta";
  onDragOut?: TabDragOut;
}

export interface TabDragOut {
  accepts: (id: string) => boolean;
  move: (id: string, x: number, y: number) => void;
  drop: (id: string, x: number, y: number) => void;
  cancel: () => void;
}

const MIN_TAB_WIDTH = 136;
const MAX_TAB_WIDTH = 196;
const MEASURE_TOLERANCE_PX = 0.5;
const MENU_WINDOW_GUTTER_PX = 12;
const MENU_ANCHOR_INSET_PX = 8;
const DRAG_START_PX = 4;
const DRAG_EDGE_PX = 28;
const DRAG_STEP_MS = 350;
const DRAG_OUT_PX = 12;

interface DragGeometry {
  tabWidth: number;
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
  startX: number;
  out: boolean;
  geometry: DragGeometry;
  windowStart: number;
}

function dragTargetFrom(drag: ActiveDrag, windowStart: number, windowSize: number, total: number) {
  const { geometry } = drag;
  const center = drag.pointerX - geometry.grabOffset + geometry.tabWidth / 2;
  const slot = Math.floor((center - geometry.left) / geometry.tabWidth);
  const windowSlot = Math.max(0, Math.min(windowSize - 1, slot));
  return Math.max(0, Math.min(total - 1, windowStart + windowSlot));
}

function draggedSlotOf(index: number, fromIndex: number, target: number) {
  const withoutDragged = index < fromIndex ? index : index - 1;
  return withoutDragged < target ? withoutDragged : withoutDragged + 1;
}

export function WorkspaceTabScroller({
  children,
  items,
  activeTabId,
  arrangementKey,
  menuLabel = "All terminals",
  menuAlwaysShown = false,
  trailing,
  onReorder,
  reorderModifier = "control",
  onDragOut,
}: WorkspaceTabScrollerProps) {
  const dragOutRef = useRef(onDragOut);
  dragOutRef.current = onDragOut;
  const listRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [listWidth, setListWidth] = useState(0);
  const [trailingWidth, setTrailingWidth] = useState(0);
  const [start, setStart] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const { present: menuPresent, closing: menuClosing } = usePopoverExit(menuOpen);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, maxHeight: 0 });
  const tabs = Children.toArray(children);
  const count = tabs.length;
  const available = Math.max(0, listWidth - trailingWidth);
  const measured = available > 0;
  const overflow = measured && count * MIN_TAB_WIDTH > available;
  const pageSize = measured
    ? Math.min(count, Math.max(1, Math.floor(available / MIN_TAB_WIDTH)))
    : count;
  const tabWidth = measured
    ? Math.min(MAX_TAB_WIDTH, available / Math.max(1, pageSize))
    : MAX_TAB_WIDTH;
  const lastStart = Math.max(0, count - pageSize);
  const visibleStart = overflow ? Math.min(start, lastStart) : 0;
  const menuButtonShown = count > 0 && (menuAlwaysShown || overflow || menuOpen);
  const activeIndex = items.findIndex((item) => item.active);
  const pendingDragRef = useRef<PendingDrag | null>(null);
  const activeDragRef = useRef<ActiveDrag | null>(null);
  const grabbedHandleRef = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState<ActiveDrag | null>(null);
  const [dragEdge, setDragEdge] = useState<-1 | 0 | 1>(0);
  const frameRef = useRef<number | null>(null);
  const pointerXRef = useRef<number | null>(null);
  const pointerYRef = useRef<number | null>(null);
  const dragScrollRef = useRef<{ direction: -1 | 0 | 1; timer: number | null }>({
    direction: 0,
    timer: null,
  });
  const clickGuardRef = useRef<(() => void) | null>(null);
  const pendingDisarmsRef = useRef(new Map<() => void, number>());
  const filterRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  const keepMenuOnRearrangeRef = useRef(false);
  const refocusMenuIndexRef = useRef<number | null>(null);
  const focusFilterRef = useRef(false);
  const hiddenRight = Math.max(0, count - visibleStart - pageSize);
  const hiddenAttention = items
    .filter((_, index) => index < visibleStart || index >= visibleStart + pageSize)
    .some((item) => item.attention);
  const query = filter.trim().toLowerCase();
  const matches = items
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) => !query || `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(query),
    );
  const sectioned = new Set(items.map((item) => item.kind ?? "remote")).size > 1;
  const sections = sectioned
    ? MENU_SECTIONS.map((section) => ({
        ...section,
        rows: matches.filter(({ item }) => (item.kind ?? "remote") === section.kind),
      })).filter((section) => section.rows.length > 0)
    : [{ kind: null, label: null, rows: matches }];

  useEffect(() => {
    if (keepMenuOnRearrangeRef.current) {
      keepMenuOnRearrangeRef.current = false;
      return;
    }
    setMenuOpen(false);
  }, [arrangementKey]);

  useEffect(() => {
    if (count === 0) setMenuOpen(false);
  }, [count]);

  useEffect(() => {
    if (menuOpen) return;
    setFilter("");
    keepMenuOnRearrangeRef.current = false;
    refocusMenuIndexRef.current = null;
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (!focusFilterRef.current) return;
    focusFilterRef.current = false;
    filterRef.current?.focus();
  }, [filter]);

  useLayoutEffect(() => {
    const index = refocusMenuIndexRef.current;
    if (index === null || !menuRef.current) return;
    refocusMenuIndexRef.current = null;
    const rows = [...menuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const row = rows[Math.min(index, rows.length - 1)];
    if (row) focusMenuRow(row);
    else pickerRef.current?.focus();
  }, [items.length]);

  const hasTrailing = trailing !== undefined;
  const measureStrip = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const settle = (next: number) => (current: number) =>
      Math.abs(current - next) < MEASURE_TOLERANCE_PX ? current : next;
    setListWidth(settle(list.getBoundingClientRect().width));
    setTrailingWidth(settle(trailingRef.current?.getBoundingClientRect().width ?? 0));
  }, []);

  useLayoutEffect(measureStrip);

  useLayoutEffect(() => {
    const list = listRef.current;
    const trailingElement = trailingRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => flushSync(measureStrip));
    observer.observe(list);
    if (trailingElement) observer.observe(trailingElement);
    return () => observer.disconnect();
  }, [hasTrailing, measureStrip]);

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
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || pickerRef.current?.contains(target)) return;
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
    const menuWidth = Math.min(360, window.innerWidth - MENU_WINDOW_GUTTER_PX * 2);
    const gap = 6;
    const below = window.innerHeight - anchor.bottom - gap - 8;
    const above = anchor.top - gap - 8;
    const useAbove = below < 128 && above > below;
    const maxHeight = Math.min(480, Math.max(0, useAbove ? above : below));
    const height = Math.min(menuRef.current.scrollHeight, maxHeight);
    setMenuPosition({
      left: Math.max(
        MENU_WINDOW_GUTTER_PX,
        Math.min(
          anchor.left + MENU_ANCHOR_INSET_PX,
          window.innerWidth - menuWidth - MENU_WINDOW_GUTTER_PX,
        ),
      ),
      top: useAbove ? Math.max(8, anchor.top - height - gap) : anchor.bottom + gap,
      maxHeight,
    });
    const row =
      menuRef.current.querySelector<HTMLElement>('[role="menuitem"][aria-current="page"]') ??
      menuRef.current.querySelector<HTMLElement>('[role="menuitem"]');
    if (row) focusMenuRow(row);
  }, [menuOpen]);

  function selectFromMenu(item: WorkspaceTabOption, index: number) {
    closeMenu();
    setStart((current) =>
      index < current || index >= current + pageSize ? Math.min(index, lastStart) : current,
    );
    item.onSelect();
  }

  function closeFromMenu(item: WorkspaceTabOption, row: number) {
    if (!item.onClose) return;
    keepMenuOnRearrangeRef.current = true;
    refocusMenuIndexRef.current = row;
    item.onClose();
  }

  function menuRows() {
    return [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  }

  function handleMenuKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      closeMenu();
      return;
    }
    const rows = menuRows();
    const inFilter = event.target === filterRef.current;
    if (inFilter) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (rows[0]) focusMenuRow(rows[0]);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const first = sections[0]?.rows[0];
        if (first) selectFromMenu(first.item, first.index);
      }
      return;
    }
    const current = rows.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Delete" && current >= 0) {
      const match = matches[Number(rows[current].dataset.match)];
      if (match?.item.onClose) {
        event.preventDefault();
        closeFromMenu(match.item, current);
      }
      return;
    }
    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (printable || (event.key === "Backspace" && filter)) {
      event.preventDefault();
      setFilter((value) => (printable ? value + event.key : value.slice(0, -1)));
      focusFilterRef.current = true;
      return;
    }
    if (event.key === "ArrowUp" && current === 0 && filterRef.current) {
      event.preventDefault();
      filterRef.current.focus();
      return;
    }
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key) || rows.length === 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    if (rows[next]) focusMenuRow(rows[next]);
  }

  function closeMenu() {
    setMenuOpen(false);
    pickerRef.current?.focus();
  }

  function stopDragScroll() {
    const { timer } = dragScrollRef.current;
    dragScrollRef.current = { direction: 0, timer: null };
    if (timer !== null) window.clearInterval(timer);
    setDragEdge(0);
  }

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
    setDragEdge(direction);
  }

  function carriedOut(active: ActiveDrag, y: number) {
    return y > active.geometry.bottom + DRAG_OUT_PX && !!dragOutRef.current?.accepts(active.id);
  }

  function flushDragFrame() {
    frameRef.current = null;
    const active = activeDragRef.current;
    if (!active) return;
    const x = pointerXRef.current;
    const y = pointerYRef.current;
    pointerXRef.current = null;
    pointerYRef.current = null;
    if (x === null || y === null) return;
    const out = carriedOut(active, y);
    const next = { ...active, pointerX: out ? active.startX : x, out };
    activeDragRef.current = next;
    setDragging(next);
    if (out) {
      stopDragScroll();
      dragOutRef.current?.move(active.id, x, y);
    } else {
      if (active.out) dragOutRef.current?.cancel();
      steerDragScroll(x, next.geometry);
    }
  }

  function finishDrag() {
    if (activeDragRef.current?.out) dragOutRef.current?.cancel();
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    pointerXRef.current = null;
    pointerYRef.current = null;
    stopDragScroll();
    pendingDragRef.current = null;
    activeDragRef.current = null;
    setDragging(null);
    disarmClickSuppression();
  }

  const moveDragRef = useRef<(event: PointerEvent) => void>(() => undefined);
  const finishDragRef = useRef(finishDrag);
  finishDragRef.current = finishDrag;
  const stopDragScrollRef = useRef(stopDragScroll);
  stopDragScrollRef.current = stopDragScroll;

  // A pointerup that ends a drag is still followed by a click.
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
    const timer = window.setTimeout(() => {
      pendingDisarmsRef.current.delete(disarm);
      disarm();
    }, 0);
    pendingDisarmsRef.current.set(disarm, timer);
  }

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

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      stopDragScrollRef.current();
      clickGuardRef.current?.();
      clickGuardRef.current = null;
      for (const [disarm, timer] of pendingDisarmsRef.current) {
        window.clearTimeout(timer);
        disarm();
      }
      pendingDisarmsRef.current.clear();
    },
    [],
  );

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

  function followPendingPress(pointerId: number) {
    const follow = (event: PointerEvent) => {
      if (event.pointerId === pointerId) moveDragRef.current(event);
    };
    const stop = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", follow);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", follow);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
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
    grabbedHandleRef.current = (event.target as Element).closest<HTMLElement>(
      ".session-tab-main, .session-tab-group-main",
    );
    // Capturing on pointerdown would retarget the click that selects a tab.
    followPendingPress(event.pointerId);
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

  function moveDrag(event: PointerEvent | ReactPointerEvent<HTMLDivElement>) {
    const active = activeDragRef.current;
    if (active && active.pointerId === event.pointerId) {
      event.preventDefault();
      pointerXRef.current = event.clientX;
      pointerYRef.current = event.clientY;
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(flushDragFrame);
      return;
    }
    const pending = pendingDragRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    const dx = event.clientX - pending.startX;
    const dy = event.clientY - pending.startY;
    if (dx * dx + dy * dy < DRAG_START_PX * DRAG_START_PX) return;
    event.preventDefault();
    const content = contentRef.current;
    try {
      content?.setPointerCapture(event.pointerId);
    } catch {}
    armClickSuppression();
    activeDragRef.current = {
      pointerId: pending.pointerId,
      id: pending.id,
      fromIndex: pending.fromIndex,
      pointerX: event.clientX,
      startX: pending.startX,
      out: false,
      geometry: pending.geometry,
      windowStart: visibleStart,
    };
    pendingDragRef.current = null;
    setDragging(activeDragRef.current);
    steerDragScroll(event.clientX, activeDragRef.current.geometry);
    pointerXRef.current = event.clientX;
    pointerYRef.current = event.clientY;
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(flushDragFrame);
  }

  moveDragRef.current = moveDrag;

  function releaseDrag(event: ReactPointerEvent<HTMLDivElement>) {
    pendingDragRef.current = null;
    const active = activeDragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const out = carriedOut(active, event.clientY);
    finishDrag();
    // macOS WebKit never focuses a pressed button, and a drag produces no click.
    const handle = grabbedHandleRef.current;
    grabbedHandleRef.current = null;
    if (!out)
      requestAnimationFrame(() => {
        if (handle?.isConnected) handle.focus({ preventScroll: true });
      });
    if (out) {
      dragOutRef.current?.drop(active.id, event.clientX, event.clientY);
      return;
    }
    if (!onReorder) return;
    const { geometry } = active;
    const inside =
      event.clientX >= geometry.left &&
      event.clientX <= geometry.right &&
      event.clientY >= geometry.top &&
      event.clientY <= geometry.bottom;
    if (!inside) return;
    const target = dragTargetFrom(
      { ...active, pointerX: event.clientX },
      visibleStart,
      pageSize,
      count,
    );
    if (target !== active.fromIndex) onReorder(active.id, target);
  }

  function reorderWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!onReorder || count < 2 || activeDragRef.current) return;
    const modifier = reorderModifier === "meta" ? event.metaKey : event.ctrlKey;
    if (!modifier || !event.shiftKey) return;
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
    if (!list || !overflow || pageSize === 0) return;
    let accumulated = 0;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const wheel = (event: WheelEvent) => {
      if (event.target instanceof Node && trailingRef.current?.contains(event.target)) return;
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
  const dragTarget = activeDrag ? dragTargetFrom(activeDrag, visibleStart, pageSize, count) : null;
  const visibleCount = Math.min(pageSize, count - visibleStart);
  const renderedTabs = activeDrag
    ? tabs.flatMap((tab, index) => {
        if (!isValidElement(tab) || dragTarget === null) return [];
        const element = tab as ReactElement<{ className?: string; style?: CSSProperties }>;
        const geometry = activeDrag.geometry;
        const classes = [element.props.className ?? ""];
        const style: CSSProperties = {
          ...element.props.style,
          position: "absolute",
          left: (index - activeDrag.windowStart) * geometry.tabWidth,
          top: 0,
          bottom: 0,
          width: geometry.tabWidth,
        };
        if (index === activeDrag.fromIndex) {
          classes.push("session-tab-dragged");
          style.zIndex = 30;
          const followed = activeDrag.pointerX - geometry.grabOffset;
          const clamped = Math.max(
            geometry.left,
            Math.min(geometry.right - geometry.tabWidth, followed),
          );
          style.transform = `translate3d(${clamped - geometry.left - (index - activeDrag.windowStart) * geometry.tabWidth}px, 0, 0)`;
        } else {
          const slot = draggedSlotOf(index, activeDrag.fromIndex, dragTarget);
          if (slot < visibleStart - 1 || slot > visibleStart + pageSize) return [];
          if (slot !== index) classes.push("session-tab-shifted");
          style.transform = `translate3d(${(slot - visibleStart - index + activeDrag.windowStart) * geometry.tabWidth}px, 0, 0)`;
        }
        return [cloneElement(element, { className: classes.filter(Boolean).join(" "), style })];
      })
    : tabs.slice(visibleStart, visibleStart + pageSize);

  return (
    <div
      className={[
        "session-tab-scroll-region",
        onReorder ? "can-reorder" : "",
        activeDrag ? "dragging" : "",
        activeDrag?.out ? "dragging-out" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {menuButtonShown && (
        <button
          ref={pickerRef}
          className="session-tab-menu-button"
          type="button"
          aria-label={menuLabel}
          title={
            menuOpen
              ? undefined
              : menuButtonTitle(menuLabel, visibleStart + hiddenRight, hiddenAttention)
          }
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-attention={hiddenAttention || undefined}
          onClick={() => setMenuOpen((current) => !current)}
        >
          <span className="session-tab-menu-button-icon" aria-hidden="true">
            <GalleryVerticalEnd size={14} />
          </span>
          <span className="session-tab-menu-count" data-count={count} aria-hidden="true" />
        </button>
      )}
      <div
        className="session-tab-list"
        ref={listRef}
        data-tauri-drag-region
        data-more-left={visibleStart > 0 || undefined}
        data-more-right={hiddenRight > 0 || undefined}
        data-drag-edge={dragEdge < 0 ? "left" : dragEdge > 0 ? "right" : undefined}
      >
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
          style={
            {
              "--session-tab-width": `${tabWidth}px`,
              width: activeDrag
                ? visibleCount * activeDrag.geometry.tabWidth
                : measured
                  ? visibleCount * tabWidth
                  : undefined,
            } as CSSProperties
          }
        >
          {renderedTabs}
        </div>
        {trailing !== undefined && (
          <div className="session-tab-trailing" ref={trailingRef}>
            {trailing}
          </div>
        )}
      </div>
      {menuButtonShown && menuPresent && (
        <div
          ref={menuRef}
          className="session-tab-overflow-menu"
          style={menuPosition}
          aria-hidden={menuClosing || undefined}
          inert={menuClosing || undefined}
          data-closing={menuClosing || undefined}
          data-app-popover=""
          onKeyDown={handleMenuKey}
        >
          <div className="session-tab-menu-heading" aria-hidden="true">
            <span>{menuLabel}</span>
            <span className="session-tab-menu-heading-count">{count} open</span>
          </div>
          {(count >= MENU_FILTER_MIN_ITEMS || filter) && (
            <input
              ref={filterRef}
              className="session-tab-menu-filter"
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter terminals"
              aria-label="Filter terminals"
              spellCheck={false}
              autoComplete="off"
            />
          )}
          <div role="menu" aria-label={`${menuLabel} menu`}>
            {sections.map((section) => {
              const rows = section.rows.map(({ item, index }) => {
                const match = matches.findIndex((entry) => entry.index === index);
                const side =
                  index < visibleStart ? "left" : index >= visibleStart + pageSize ? "right" : null;
                return (
                  <div className="session-tab-menu-row" role="none" key={item.id}>
                    <button
                      role="menuitem"
                      type="button"
                      data-match={match}
                      aria-current={item.active ? "page" : undefined}
                      aria-keyshortcuts={item.onClose ? "Delete" : undefined}
                      onClick={() => selectFromMenu(item, index)}
                    >
                      {item.icon && (
                        <span className="session-tab-menu-icon" aria-hidden="true">
                          {item.icon}
                        </span>
                      )}
                      <span className="session-tab-menu-name">
                        {item.label}
                        {item.detail && <small> {item.detail}</small>}
                      </span>
                      {item.status && (
                        <span
                          className="session-tab-menu-status"
                          data-attention={item.attention || undefined}
                        >
                          <span className="sr-only">, </span>
                          {item.status}
                        </span>
                      )}
                      {side && (
                        <span className="session-tab-menu-side" title={`Hidden to the ${side}`}>
                          <span className="sr-only">, hidden to the {side}</span>
                          {side === "left" ? (
                            <ChevronLeft size={13} aria-hidden="true" />
                          ) : (
                            <ChevronRight size={13} aria-hidden="true" />
                          )}
                        </span>
                      )}
                    </button>
                    {item.onClose && (
                      <span
                        className="session-tab-menu-close"
                        aria-hidden="true"
                        title={`Close ${item.label}`}
                        onClick={() => closeFromMenu(item, Math.max(0, match))}
                      >
                        <X size={13} />
                      </span>
                    )}
                  </div>
                );
              });
              return section.label ? (
                <div role="group" aria-label={section.label} key={section.kind}>
                  <div className="session-tab-menu-section" aria-hidden="true">
                    {section.label}
                  </div>
                  {rows}
                </div>
              ) : (
                rows
              );
            })}
          </div>
          {matches.length === 0 && <p className="session-tab-menu-empty">No matching terminals</p>}
        </div>
      )}
    </div>
  );
}
