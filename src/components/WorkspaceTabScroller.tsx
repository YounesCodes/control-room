import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface WorkspaceTabScrollerProps {
  children: ReactNode;
  activeTabId: string | null;
  arrangementKey: string;
}

export function WorkspaceTabScroller({
  children,
  activeTabId,
  arrangementKey,
}: WorkspaceTabScrollerProps) {
  const regionRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const endSpaceRef = useRef<HTMLSpanElement>(null);
  const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [listWidth, setListWidth] = useState(0);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const tabStarts = useCallback(() => {
    const content = contentRef.current;
    if (!content) return [0];
    const contentLeft = content.getBoundingClientRect().left;
    return [
      0,
      ...Array.from(
        content.querySelectorAll<HTMLElement>(".session-tab-wrap, .session-tab-group"),
        (tab) => tab.getBoundingClientRect().left - contentLeft,
      ),
    ].sort((a, b) => a - b);
  }, []);

  const snapToTab = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const active = contentRef.current?.querySelector<HTMLElement>(".session-tab-wrap.active");
    if (active && active.offsetWidth > list.clientWidth) return;
    const current = list.scrollLeft;
    const nearest = tabStarts().reduce((best, start) =>
      Math.abs(start - current) < Math.abs(best - current) ? start : best,
    );
    if (Math.abs(nearest - current) > 1) list.scrollLeft = nearest;
  }, [tabStarts]);

  const scheduleSnap = useCallback(() => {
    if (snapTimerRef.current) clearTimeout(snapTimerRef.current);
    snapTimerRef.current = setTimeout(() => {
      snapTimerRef.current = null;
      snapToTab();
    }, 120);
  }, [snapToTab]);

  const updateScrollState = useCallback(() => {
    const region = regionRef.current;
    const list = listRef.current;
    const content = contentRef.current;
    const endSpace = endSpaceRef.current;
    if (!region || !list || !content || !endSpace) return;
    const naturalWidth =
      endSpace.getBoundingClientRect().left - content.getBoundingClientRect().left;
    const naturalEnd = naturalWidth - list.clientWidth;
    const finalStart = tabStarts().find((start) => start >= naturalEnd - 1);
    endSpace.style.width = `${Math.max(0, Math.ceil((finalStart ?? naturalEnd) - naturalEnd))}px`;
    setOverflow(content.scrollWidth > region.clientWidth + 1);
    setListWidth(list.clientWidth);
    setCanScrollLeft(list.scrollLeft > 1);
    setCanScrollRight(list.scrollLeft + list.clientWidth < list.scrollWidth - 1);
  }, [tabStarts]);

  useEffect(
    () => () => {
      if (snapTimerRef.current) clearTimeout(snapTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const region = regionRef.current;
    const list = listRef.current;
    const content = contentRef.current;
    if (!region || !list || !content) return;
    if (typeof ResizeObserver === "undefined") {
      updateScrollState();
      return;
    }
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(region);
    observer.observe(list);
    observer.observe(content);
    updateScrollState();
    return () => observer.disconnect();
  }, [updateScrollState]);

  useLayoutEffect(() => {
    if (!activeTabId) return;
    const list = listRef.current;
    const active = contentRef.current?.querySelector<HTMLElement>(".session-tab-wrap.active");
    if (!list || !active || list.clientWidth === 0) return;
    const listRect = list.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.left < listRect.left || activeRect.right > listRect.right) {
      list.scrollLeft +=
        activeRect.width > listRect.width
          ? activeRect.right - listRect.right
          : activeRect.left - listRect.left;
    }
    updateScrollState();
  }, [activeTabId, arrangementKey, overflow, listWidth, updateScrollState]);

  function scrollTabs(direction: -1 | 1) {
    const list = listRef.current;
    if (!list) return;
    const target = list.scrollLeft + direction * Math.max(160, list.clientWidth * 0.8);
    const starts = tabStarts().filter((start) =>
      direction > 0 ? start > list.scrollLeft + 1 : start < list.scrollLeft - 1,
    );
    const start =
      direction > 0
        ? (starts.filter((value) => value <= target).at(-1) ?? starts[0])
        : (starts.find((value) => value >= target) ?? starts.at(-1));
    if (start !== undefined) list.scrollLeft = start;
  }

  return (
    <div className="session-tab-scroll-region" ref={regionRef}>
      {overflow && (
        <button
          className="session-tab-scroll-button"
          type="button"
          onClick={() => scrollTabs(-1)}
          disabled={!canScrollLeft}
          aria-label="Scroll terminals left"
          title="Scroll terminals left"
        >
          <ChevronLeft size={15} />
        </button>
      )}
      <div
        className="session-tab-list"
        ref={listRef}
        data-tauri-drag-region
        onScroll={() => {
          updateScrollState();
          scheduleSnap();
        }}
        onWheel={(event) => {
          if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
          event.currentTarget.scrollLeft += event.deltaY;
        }}
      >
        <div className="session-tab-content" ref={contentRef}>
          {children}
          <span className="session-tab-end-space" ref={endSpaceRef} aria-hidden="true" />
        </div>
      </div>
      {overflow && (
        <button
          className="session-tab-scroll-button"
          type="button"
          onClick={() => scrollTabs(1)}
          disabled={!canScrollRight}
          aria-label="Scroll terminals right"
          title="Scroll terminals right"
        >
          <ChevronRight size={15} />
        </button>
      )}
    </div>
  );
}
