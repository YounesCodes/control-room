import { useLayoutEffect, useRef, type RefObject } from "react";

/** Animate flat, keyed live panes. ResizeObserver fits once after the motion settles. */
export function useTerminalLayoutMotion(
  container: RefObject<HTMLDivElement | null>,
  topology: string,
  viewportKey: string,
  geometryKey: string,
) {
  const previous = useRef<{
    topology: string;
    viewportKey: string;
    boxes: Map<string, { left: number; top: number; width: number; height: number }>;
  } | null>(null);
  const animations = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    const nodes = [
      ...(container.current?.querySelectorAll<HTMLElement>(
        ".terminal-workspace-pane-visible, .terminal-pane-heading",
      ) ?? []),
    ];
    animations.current.forEach((animation) => animation.cancel());
    animations.current = [];
    const boxes = new Map(
      nodes.map((node) => [
        (node.dataset.terminalMotionId ?? node.dataset.workspaceId)!,
        {
          left: node.offsetLeft,
          top: node.offsetTop,
          width: node.offsetWidth,
          height: node.offsetHeight,
        },
      ]),
    );
    const before = previous.current;
    previous.current = { topology, viewportKey, boxes };
    if (
      !before ||
      before.topology === topology ||
      before.viewportKey !== viewportKey ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return;
    // Switching groups or individual tabs is selection, not a layout edit.
    if (![...boxes.keys()].some((id) => before.boxes.has(id))) return;
    for (const node of nodes) {
      if (typeof node.animate !== "function") continue;
      const id = (node.dataset.terminalMotionId ?? node.dataset.workspaceId)!;
      const next = boxes.get(id)!;
      const old = before.boxes.get(id);
      const parent = [...before.boxes.values()].find(
        (box) =>
          next.left >= box.left &&
          next.top >= box.top &&
          next.left + next.width <= box.left + box.width + 1 &&
          next.top + next.height <= box.top + box.height + 1,
      );
      const start =
        old ??
        ((parent ? next.width < parent.width : next.width < next.height)
          ? { ...next, left: next.left + next.width, width: 0 }
          : { ...next, top: next.top + next.height, height: 0 });
      if (JSON.stringify(start) === JSON.stringify(next)) continue;
      const pixels = (box: typeof next) =>
        Object.fromEntries(Object.entries(box).map(([key, value]) => [key, `${value}px`]));
      animations.current.push(
        node.animate([pixels(start), pixels(next)], {
          duration: 200,
          easing: "cubic-bezier(.2,.8,.2,1)",
        }),
      );
    }
  }, [container, topology, viewportKey, geometryKey]);
  useLayoutEffect(() => () => animations.current.forEach((animation) => animation.cancel()), []);
}
