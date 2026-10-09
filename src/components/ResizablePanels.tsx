import {
  createContext,
  useContext,
  useLayoutEffect,
  useEffect,
  type CSSProperties,
  useRef,
  useState,
  type ReactNode,
  type ContextType,
} from "react";
import { clampPanelSize, PANEL_LIMITS, type PanelSizes } from "../lib/panel-layout";

export const PanelLayoutContext = createContext<{
  sizes: PanelSizes;
  setSize: (key: string, size: number | null) => void;
}>({ sizes: {}, setSize: () => undefined });

// A parent can resize after its own React measurement. Watch ancestor layout
// changes as well as the window when this WebView has no ResizeObserver.
// Ancestor style/class mutations miss resizes caused by cascading React state
// (window shrinks -> outer panel remeasures -> inner width style updates ->
// split fraction updates -> canvas shrinks). Poll the element's own box every
// frame so the final size always triggers one more measurement.
export function observeLayoutFallback(element: HTMLElement, measure: () => void) {
  let frame: number | null = null;
  let watchFrame: number | null = null;
  let disposed = false;
  const snapshot = () => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  };
  let last = snapshot();
  const schedule = () => {
    if (disposed) return;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      if (disposed) return;
      last = snapshot();
      measure();
    });
  };
  const watch = () => {
    if (disposed) return;
    const current = snapshot();
    if (current.width !== last.width || current.height !== last.height) {
      schedule();
    }
    watchFrame = requestAnimationFrame(watch);
  };
  const observer = new MutationObserver(schedule);
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    observer.observe(ancestor, { attributes: true, attributeFilter: ["style", "class"] });
  }
  window.addEventListener("resize", schedule);
  watchFrame = requestAnimationFrame(watch);
  return () => {
    disposed = true;
    observer.disconnect();
    window.removeEventListener("resize", schedule);
    if (frame !== null) cancelAnimationFrame(frame);
    if (watchFrame !== null) cancelAnimationFrame(watchFrame);
    frame = null;
    watchFrame = null;
  };
}

function usePanelDimension(dimension: "width" | "height") {
  const [element, ref] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () =>
      setSize(dimension === "width" ? element.clientWidth : element.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") {
      return observeLayoutFallback(element, measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, dimension]);
  return { ref, size };
}

export function usePanelWidth() {
  const { ref, size } = usePanelDimension("width");
  return { ref, width: size };
}

export function SidebarSections({
  hosts,
  capabilities,
  layout,
}: {
  hosts: ReactNode;
  capabilities: ReactNode;
  layout: ContextType<typeof PanelLayoutContext>;
}) {
  const { sizes, setSize } = layout;
  const { ref, size: height } = usePanelDimension("height");
  const key = "sidebar:hosts";
  const max = Math.max(
    0,
    Math.min(PANEL_LIMITS.sidebarHosts.max, height - 6 - PANEL_LIMITS.sidebarHosts.min),
  );
  const min = Math.min(PANEL_LIMITS.sidebarHosts.min, max);
  const size = clampPanelSize(sizes[key] ?? height * 0.45, min, max);
  return (
    <div
      ref={ref}
      className={`sidebar-sections${capabilities ? " with-capabilities" : ""}`}
      style={
        capabilities && height ? { gridTemplateRows: `${size}px 6px minmax(0, 1fr)` } : undefined
      }
    >
      {hosts}
      {capabilities && (
        <>
          <ResizeDivider
            label="Resize Hosts and Capabilities"
            orientation="horizontal"
            value={size}
            min={min}
            max={max}
            className="sidebar-sections-divider"
            style={{ top: size + 3 }}
            onChange={(next) => setSize(key, next)}
            onReset={() => setSize(key, null)}
          />
          {capabilities}
        </>
      )}
    </div>
  );
}

export function ResizeDivider({
  label,
  orientation = "vertical",
  value,
  min,
  max,
  onChange,
  onReset,
  className = "",
  style,
}: {
  label: string;
  orientation?: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  onChange: (size: number) => void;
  onReset: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const drag = useRef<{ id: number; start: number; size: number } | null>(null);
  const horizontal = orientation === "horizontal";
  const coordinate = (event: { clientX: number; clientY: number }) =>
    horizontal ? event.clientY : event.clientX;
  const [dragging, setDragging] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  const latest = useRef({ min, max, onChange });
  latest.current = { min, max, onChange };
  const frame = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  function flush() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const next = pending.current;
    pending.current = null;
    if (next !== null)
      latest.current.onChange(clampPanelSize(next, latest.current.min, latest.current.max));
  }
  function cancel() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    pending.current = null;
    if (drag.current)
      latest.current.onChange(
        clampPanelSize(drag.current.size, latest.current.min, latest.current.max),
      );
    drag.current = null;
    setDragging(false);
  }
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  useLayoutEffect(() => {
    const node = element.current;
    return () => {
      if (document.activeElement === node) node?.closest<HTMLElement>(".resizable-split")?.focus();
    };
  }, []);
  return (
    <div
      ref={element}
      style={style}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      title={`${label}. Drag or use ${horizontal ? "Up and Down" : "Left and Right"} arrows. Double-click or press Enter to reset.`}
      className={`resize-divider ${className}${dragging ? " dragging" : ""}`}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === "Escape" && drag.current) {
          event.preventDefault();
          cancel();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          onReset();
          return;
        }
        const step = event.shiftKey ? 50 : 10;
        const next =
          event.key === (horizontal ? "ArrowUp" : "ArrowLeft")
            ? value - step
            : event.key === (horizontal ? "ArrowDown" : "ArrowRight")
              ? value + step
              : event.key === "Home"
                ? min
                : event.key === "End"
                  ? max
                  : null;
        if (next !== null) {
          event.preventDefault();
          onChange(clampPanelSize(next, min, max));
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, start: coordinate(event), size: value };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        pending.current = drag.current.size + coordinate(event) - drag.current.start;
        if (frame.current === null) frame.current = requestAnimationFrame(flush);
      }}
      onPointerUp={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        flush();
        event.currentTarget.releasePointerCapture(event.pointerId);
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={() => {
        flush();
        drag.current = null;
        setDragging(false);
      }}
    />
  );
}

export function ConnectionSection({
  section,
  children,
  layout,
}: {
  section: string;
  children: ReactNode;
  layout?: ContextType<typeof PanelLayoutContext>;
}) {
  const context = useContext(PanelLayoutContext);
  const { sizes, setSize } = layout ?? context;
  const { ref, width } = usePanelWidth();
  const key = `content:${section}`;
  const max = Math.min(PANEL_LIMITS.content.max, width || PANEL_LIMITS.content.max);
  const min = Math.min(PANEL_LIMITS.content.min, max);
  const size = clampPanelSize(sizes[key] ?? max, min, max);
  if (section === "terminal") return null;
  return (
    <PanelLayoutContext.Provider value={layout ?? context}>
      <div ref={ref} className="connection-section">
        <div className="connection-section-content" style={{ width: width ? size : "100%" }}>
          {children}
          <ResizeDivider
            label={`Resize ${section.charAt(0).toUpperCase() + section.slice(1)} content`}
            value={size}
            min={min}
            max={max}
            className="content-divider"
            onChange={(next) => setSize(key, next)}
            onReset={() => setSize(key, null)}
          />
        </div>
      </div>
    </PanelLayoutContext.Provider>
  );
}

export function ResizableSplit({
  name,
  className,
  children,
  defaultFraction = 0.55,
}: {
  name: string;
  className: string;
  children: ReactNode;
  defaultFraction?: number;
}) {
  const { sizes, setSize } = useContext(PanelLayoutContext);
  const { ref, width } = usePanelWidth();
  const key = `split:${name}`;
  const stacked = width > 0 && width < 566;
  const min = PANEL_LIMITS.split.min;
  const max = Math.max(min, Math.min(PANEL_LIMITS.split.max, width - min - 6));
  const size = clampPanelSize(sizes[key] ?? (width - 6) * defaultFraction, min, max);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-label={`${name} panes`}
      className={`${className} resizable-split${stacked ? " stacked" : ""}`}
      style={width && !stacked ? { gridTemplateColumns: `${size}px minmax(0, 1fr)` } : undefined}
    >
      {children}
      {!stacked && (
        <ResizeDivider
          label={`Resize ${name} panes`}
          value={size}
          min={min}
          max={max}
          className="split-divider"
          style={{ left: size }}
          onChange={(next) => setSize(key, next)}
          onReset={() => setSize(key, null)}
        />
      )}
    </div>
  );
}
