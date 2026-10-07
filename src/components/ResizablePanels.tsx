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
export function observeLayoutFallback(element: HTMLElement, measure: () => void) {
  let frame: number | null = null;
  const schedule = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      measure();
    });
  };
  const observer = new MutationObserver(schedule);
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    observer.observe(ancestor, { attributes: true, attributeFilter: ["style", "class"] });
  }
  window.addEventListener("resize", schedule);
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", schedule);
    if (frame !== null) cancelAnimationFrame(frame);
  };
}

export function usePanelWidth() {
  const [element, ref] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") {
      return observeLayoutFallback(element, measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { ref, width };
}

export function ResizeDivider({
  label,
  value,
  min,
  max,
  onChange,
  onReset,
  className = "",
  style,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (size: number) => void;
  onReset: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const drag = useRef<{ id: number; x: number; size: number } | null>(null);
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
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      title={`${label}. Drag or use Left and Right arrows. Double-click or press Enter to reset.`}
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
          event.key === "ArrowLeft"
            ? value - step
            : event.key === "ArrowRight"
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
        drag.current = { id: event.pointerId, x: event.clientX, size: value };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        pending.current = drag.current.size + event.clientX - drag.current.x;
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
