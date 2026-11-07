import { useLayoutEffect, useRef } from "react";

/** Interpolate the visual reading only; accessibility always receives the measured value. */
export function AnimatedNumber({
  value,
  format,
  fallback = "Unavailable",
  animate = true,
  accessible = true,
  dragRegion = false,
  className = "",
}: {
  value: number | null | undefined;
  format: (value: number) => string;
  fallback?: string;
  animate?: boolean;
  accessible?: boolean;
  dragRegion?: boolean;
  className?: string;
}) {
  const visual = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  const target = value != null && Number.isFinite(value) && value >= 0 ? value : null;
  useLayoutEffect(() => {
    const element = visual.current;
    if (!element) return;
    let frame = 0;
    const duration = parseFloat(getComputedStyle(element).getPropertyValue("--motion-slow")) || 0;
    const paint = (number: number | null) => {
      shown.current = number;
      element.textContent = number === null ? fallback : format(number);
    };
    const finish = () => {
      cancelAnimationFrame(frame);
      paint(target);
    };
    const from = shown.current;
    if (
      from === null ||
      target === null ||
      from === target ||
      !animate ||
      document.hidden ||
      !duration
    ) {
      finish();
      return;
    }
    paint(from);
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - start) / duration));
      paint(from + (target - from) * (1 - Math.pow(1 - progress, 3)));
      if (progress < 1) frame = requestAnimationFrame(tick);
      else paint(target);
    };
    const settle = () => {
      if (document.hidden) finish();
    };
    frame = requestAnimationFrame(tick);
    document.addEventListener("visibilitychange", settle);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", settle);
    };
  }, [target, format, fallback, animate]);
  return (
    <span
      className={`animated-number ${className}`}
      data-tauri-drag-region={dragRegion || undefined}
    >
      <span ref={visual} aria-hidden="true" data-tauri-drag-region={dragRegion || undefined} />
      {accessible && <span className="sr-only">{target === null ? fallback : format(target)}</span>}
    </span>
  );
}
