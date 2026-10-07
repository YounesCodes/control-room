import {
  createContext,
  useContext,
  useLayoutEffect,
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

export function usePanelWidth() {
  const [element, ref] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
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
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (size: number) => void;
  onReset: () => void;
  className?: string;
}) {
  const drag = useRef<{ id: number; x: number; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div
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
        onChange(clampPanelSize(drag.current.size + event.clientX - drag.current.x, min, max));
      }}
      onPointerUp={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      onLostPointerCapture={() => {
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
          onChange={(next) => setSize(key, next)}
          onReset={() => setSize(key, null)}
        />
      )}
    </div>
  );
}
