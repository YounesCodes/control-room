import {
  useCallback,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
  type WheelEvent,
} from "react";

export interface PanZoomView {
  scale: number;
  x: number;
  y: number;
}

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2.5;

function clampScale(scale: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/**
 * Excalidraw-style pan and zoom for a transformed canvas: drag to pan, wheel to
 * zoom toward the cursor, and buttons to zoom toward the viewport centre. The
 * caller applies `view` as `translate(x, y) scale(scale)` with origin 0 0.
 */
export function usePanZoom(viewportRef: RefObject<HTMLElement | null>) {
  const [view, setView] = useState<PanZoomView>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      setView((current) => {
        const next = clampScale(current.scale * factor);
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        const worldX = (px - current.x) / current.scale;
        const worldY = (py - current.y) / current.scale;
        return { scale: next, x: px - worldX * next, y: py - worldY * next };
      });
    },
    [viewportRef],
  );

  const onWheel = useCallback(
    (event: WheelEvent) => {
      zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.1 : 1 / 1.1);
    },
    [zoomAt],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
    },
    [viewportRef, zoomAt],
  );

  const onPointerDown = useCallback((event: PointerEvent) => {
    if (event.button !== 0) return;
    drag.current = {
      startX: event.clientX,
      startY: event.clientY,
      ox: viewRef.current.x,
      oy: viewRef.current.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: PointerEvent) => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    setView((current) => ({ ...current, x: state.ox + dx, y: state.oy + dy }));
  }, []);

  const onPointerUp = useCallback((event: PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released; ignore.
    }
  }, []);

  const isPanning = useCallback(() => drag.current !== null, []);

  return {
    view,
    setView,
    zoomBy,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    isPanning,
  };
}
