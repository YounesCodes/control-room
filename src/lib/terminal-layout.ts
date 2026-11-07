export type TerminalSplitDirection = "vertical" | "horizontal";

export type TerminalLayout = TerminalLayoutLeaf | TerminalLayoutSplit;

interface TerminalLayoutLeaf {
  kind: "leaf";
  workspaceId: string;
}

interface TerminalLayoutSplit {
  kind: "split";
  direction: TerminalSplitDirection;
  ratio?: number;
  first: TerminalLayout;
  second: TerminalLayout;
}

export interface TerminalPaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TerminalLayoutDivider {
  path: string;
  direction: TerminalSplitDirection;
  rectangle: TerminalPaneRect;
  position: number;
  size: number;
  min: number;
  max: number;
}

export interface TerminalLayoutViewport {
  width: number;
  height: number;
}

/** Round shared edges together so adjacent panes meet on complete CSS pixels. */
export function getTerminalPanePixels(
  rectangle: TerminalPaneRect,
  viewport: TerminalLayoutViewport,
): TerminalPaneRect | null {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return null;
  const left = Math.round((rectangle.left * viewport.width) / 100);
  const top = Math.round((rectangle.top * viewport.height) / 100);
  return {
    left,
    top,
    width: Math.round(((rectangle.left + rectangle.width) * viewport.width) / 100) - left,
    height: Math.round(((rectangle.top + rectangle.height) * viewport.height) / 100) - top,
  };
}

export const MIN_TERMINAL_PANE_WIDTH = 280;
export const MIN_TERMINAL_PANE_HEIGHT = 180;

export type TerminalDropZone = "center" | "left" | "right" | "top" | "bottom";

function validMembers(layout: TerminalLayout, source: string, target: string): boolean {
  const ids = getTerminalLayoutIds(layout);
  return (
    source !== target &&
    ids.includes(source) &&
    ids.includes(target) &&
    new Set(ids).size === ids.length
  );
}

/** Exchange leaves, keeping all split geometry and session identities. */
export function swapTerminalLayout(
  layout: TerminalLayout,
  source: string,
  target: string,
): TerminalLayout {
  if (!validMembers(layout, source, target)) return layout;
  function visit(node: TerminalLayout): TerminalLayout {
    if (node.kind === "leaf") {
      if (node.workspaceId === source) return createTerminalLayout(target);
      if (node.workspaceId === target) return createTerminalLayout(source);
      return node;
    }
    const first = visit(node.first);
    const second = visit(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  }
  return visit(layout);
}

/** Detach first, collapse its ancestors, then dock beside the surviving target. */
export function dockTerminalLayout(
  layout: TerminalLayout,
  source: string,
  target: string,
  edge: Exclude<TerminalDropZone, "center">,
): TerminalLayout {
  if (!validMembers(layout, source, target) || !["left", "right", "top", "bottom"].includes(edge))
    return layout;
  const remaining = removeTerminalFromLayout(layout, source)!;
  function visit(node: TerminalLayout): TerminalLayout {
    if (node.kind === "leaf") {
      if (node.workspaceId !== target) return node;
      const moved = createTerminalLayout(source);
      const before = edge === "left" || edge === "top";
      return {
        kind: "split",
        direction: edge === "left" || edge === "right" ? "vertical" : "horizontal",
        first: before ? moved : node,
        second: before ? node : moved,
      };
    }
    const first = visit(node.first);
    const second = visit(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  }
  const result = visit(remaining);
  return JSON.stringify(result) === JSON.stringify(layout) ? layout : result;
}

export function terminalSplitDirection(
  layout: TerminalLayout,
  path: string,
): TerminalSplitDirection | null {
  if (layout.kind === "leaf") return null;
  if (path === "") return layout.direction;
  const [child, ...rest] = path.split(".");
  return child === "first" || child === "second"
    ? terminalSplitDirection(layout[child], rest.join("."))
    : null;
}

export function orientTerminalLayout(
  layout: TerminalLayout,
  path: string,
  direction: TerminalSplitDirection,
): TerminalLayout {
  if (layout.kind === "leaf" || !["vertical", "horizontal"].includes(direction)) return layout;
  if (path === "") return layout.direction === direction ? layout : { ...layout, direction };
  const [child, ...rest] = path.split(".");
  if (child !== "first" && child !== "second") return layout;
  const next = orientTerminalLayout(layout[child], rest.join("."), direction);
  return next === layout[child] ? layout : { ...layout, [child]: next };
}

export function terminalParentSplitPath(
  layout: TerminalLayout,
  workspaceId: string,
): string | null {
  function visit(node: TerminalLayout, path: string): string | null {
    if (node.kind === "leaf") return null;
    if (
      (node.first.kind === "leaf" && node.first.workspaceId === workspaceId) ||
      (node.second.kind === "leaf" && node.second.workspaceId === workspaceId)
    )
      return path;
    return (
      visit(node.first, path ? `${path}.first` : "first") ??
      visit(node.second, path ? `${path}.second` : "second")
    );
  }
  return visit(layout, "");
}

/** Coordinates are relative to the target pane; corners choose the nearest edge. */
export function terminalDropZone(x: number, y: number): TerminalDropZone | null {
  if (![x, y].every(Number.isFinite) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  const edges = [
    { zone: "left", distance: x },
    { zone: "right", distance: 1 - x },
    { zone: "top", distance: y },
    { zone: "bottom", distance: 1 - y },
  ] as const;
  const nearest = edges.reduce((a, b) => (a.distance <= b.distance ? a : b));
  return nearest.distance < 0.25 ? nearest.zone : "center";
}

export function rearrangeTerminalLayout(
  layout: TerminalLayout,
  source: string,
  target: string,
  zone: TerminalDropZone,
): TerminalLayout {
  return zone === "center"
    ? swapTerminalLayout(layout, source, target)
    : dockTerminalLayout(layout, source, target, zone);
}

export function createTerminalLayout(workspaceId: string): TerminalLayout {
  return { kind: "leaf", workspaceId };
}

export function getTerminalLayoutIds(layout: TerminalLayout): string[] {
  if (layout.kind === "leaf") return [layout.workspaceId];
  return [...getTerminalLayoutIds(layout.first), ...getTerminalLayoutIds(layout.second)];
}

export function terminalLayoutContains(layout: TerminalLayout, workspaceId: string): boolean {
  if (layout.kind === "leaf") return layout.workspaceId === workspaceId;
  return (
    terminalLayoutContains(layout.first, workspaceId) ||
    terminalLayoutContains(layout.second, workspaceId)
  );
}

export function splitTerminalLayout(
  layout: TerminalLayout,
  targetWorkspaceId: string,
  newWorkspaceId: string,
  direction: TerminalSplitDirection,
): TerminalLayout {
  if (terminalLayoutContains(layout, newWorkspaceId)) return layout;
  if (layout.kind === "leaf") {
    if (layout.workspaceId !== targetWorkspaceId) return layout;
    return {
      kind: "split",
      direction,
      first: layout,
      second: createTerminalLayout(newWorkspaceId),
    };
  }

  const first = splitTerminalLayout(layout.first, targetWorkspaceId, newWorkspaceId, direction);
  if (first !== layout.first) return { ...layout, first };
  const second = splitTerminalLayout(layout.second, targetWorkspaceId, newWorkspaceId, direction);
  return second === layout.second ? layout : { ...layout, second };
}

export function removeTerminalFromLayout(
  layout: TerminalLayout,
  workspaceId: string,
): TerminalLayout | null {
  if (layout.kind === "leaf") return layout.workspaceId === workspaceId ? null : layout;

  const first = removeTerminalFromLayout(layout.first, workspaceId);
  const second = removeTerminalFromLayout(layout.second, workspaceId);
  if (!first) return second;
  if (!second) return first;
  if (first === layout.first && second === layout.second) return layout;
  return { ...layout, first, second };
}

export function pruneTerminalLayout(
  layout: TerminalLayout | null | undefined,
  workspaceIds: Set<string>,
): TerminalLayout | null {
  const seen = new Set<string>();
  function visit(node: TerminalLayout | null | undefined): TerminalLayout | null {
    if (!node) return null;
    if (node.kind === "leaf") {
      if (!workspaceIds.has(node.workspaceId) || seen.has(node.workspaceId)) return null;
      seen.add(node.workspaceId);
      return node;
    }
    const first = visit(node.first);
    const second = visit(node.second);
    if (!first) return second;
    if (!second) return first;
    return first === node.first && second === node.second ? node : { ...node, first, second };
  }
  return visit(layout);
}

export function selectTerminalTab(layout: TerminalLayout, workspaceId: string): TerminalLayout {
  return terminalLayoutContains(layout, workspaceId) ? layout : createTerminalLayout(workspaceId);
}

/** Paths identify splits inside one group's current tree, never terminal sessions. */
export function resizeTerminalLayout(
  layout: TerminalLayout,
  path: string,
  ratio: number,
): TerminalLayout {
  if (layout.kind === "leaf" || !Number.isFinite(ratio)) return layout;
  if (path === "") return { ...layout, ratio: Math.max(0.05, Math.min(0.95, ratio)) };
  const [child, ...rest] = path.split(".");
  if (child !== "first" && child !== "second") return layout;
  const next = resizeTerminalLayout(layout[child], rest.join("."), ratio);
  return next === layout[child] ? layout : { ...layout, [child]: next };
}

export function getTerminalPaneRects(layout: TerminalLayout): Record<string, TerminalPaneRect> {
  return getResponsiveTerminalPaneRects(layout, {
    width: Number.POSITIVE_INFINITY,
    height: Number.POSITIVE_INFINITY,
  });
}

/**
 * Keeps the saved split directions at ordinary sizes, but turns an individual
 * split ninety degrees when halving its current rectangle would make either
 * child unusably narrow or short. The saved tree is untouched, so growing the
 * window restores the directions the user chose.
 */
export function getResponsiveTerminalPaneRects(
  layout: TerminalLayout,
  viewport: TerminalLayoutViewport,
): Record<string, TerminalPaneRect> {
  return getResponsiveTerminalGeometry(layout, viewport).panes;
}

export function getResponsiveTerminalGeometry(
  layout: TerminalLayout,
  viewport: TerminalLayoutViewport,
  adapt = true,
): { panes: Record<string, TerminalPaneRect>; dividers: TerminalLayoutDivider[] } {
  const rectangles: Record<string, TerminalPaneRect> = {};
  const dividers: TerminalLayoutDivider[] = [];

  function visit(
    node: TerminalLayout,
    rectangle: TerminalPaneRect,
    available: TerminalLayoutViewport,
    path: string,
  ) {
    if (node.kind === "leaf") {
      rectangles[node.workspaceId] = rectangle;
      return;
    }

    const verticalRoom = available.width / 2 / MIN_TERMINAL_PANE_WIDTH;
    const horizontalRoom = available.height / 2 / MIN_TERMINAL_PANE_HEIGHT;
    const direction =
      adapt && node.direction === "vertical" && verticalRoom < 1 && horizontalRoom > verticalRoom
        ? "horizontal"
        : adapt &&
            node.direction === "horizontal" &&
            horizontalRoom < 1 &&
            verticalRoom > horizontalRoom
          ? "vertical"
          : node.direction;

    const size = direction === "vertical" ? available.width : available.height;
    const dimension = direction === "vertical" ? "width" : "height";
    const leafMinimum =
      direction === "vertical" ? MIN_TERMINAL_PANE_WIDTH : MIN_TERMINAL_PANE_HEIGHT;
    const firstMinimum = adapt ? leafMinimum : terminalLayoutMinimum(node.first)[dimension];
    const secondMinimum = adapt ? leafMinimum : terminalLayoutMinimum(node.second)[dimension];
    const crowded = firstMinimum + secondMinimum > size;
    const minRatio =
      Number.isFinite(size) && size > 0
        ? firstMinimum / (crowded ? firstMinimum + secondMinimum : size)
        : 0.05;
    const maxRatio =
      Number.isFinite(size) && size > 0 ? (crowded ? minRatio : 1 - secondMinimum / size) : 0.95;
    const savedRatio = Number.isFinite(node.ratio) ? (node.ratio ?? 0.5) : 0.5;
    const ratio = Math.max(minRatio, Math.min(maxRatio, savedRatio));
    if (Number.isFinite(size) && size > 0) {
      dividers.push({
        path,
        direction,
        rectangle,
        position: size * ratio,
        size,
        min: size * minRatio,
        max: size * maxRatio,
      });
    }
    const childPath = (child: string) => (path ? `${path}.${child}` : child);

    if (direction === "vertical") {
      const width = rectangle.width * ratio;
      visit(
        node.first,
        { ...rectangle, width },
        { ...available, width: available.width * ratio },
        childPath("first"),
      );
      visit(
        node.second,
        { ...rectangle, left: rectangle.left + width, width: rectangle.width - width },
        { ...available, width: available.width * (1 - ratio) },
        childPath("second"),
      );
      return;
    }

    const height = rectangle.height * ratio;
    visit(
      node.first,
      { ...rectangle, height },
      { ...available, height: available.height * ratio },
      childPath("first"),
    );
    visit(
      node.second,
      { ...rectangle, top: rectangle.top + height, height: rectangle.height - height },
      { ...available, height: available.height * (1 - ratio) },
      childPath("second"),
    );
  }

  visit(layout, { left: 0, top: 0, width: 100, height: 100 }, viewport, "");
  return { panes: rectangles, dividers };
}

function terminalLayoutMinimum(layout: TerminalLayout): TerminalLayoutViewport {
  if (layout.kind === "leaf")
    return { width: MIN_TERMINAL_PANE_WIDTH, height: MIN_TERMINAL_PANE_HEIGHT };
  const first = terminalLayoutMinimum(layout.first);
  const second = terminalLayoutMinimum(layout.second);
  return layout.direction === "vertical"
    ? { width: first.width + second.width, height: Math.max(first.height, second.height) }
    : { width: Math.max(first.width, second.width), height: first.height + second.height };
}

/** Choose directions before scrollbars take space, then size panes in the visible viewport. */
export function getTerminalLayoutSurface(
  layout: TerminalLayout,
  visible: TerminalLayoutViewport,
  available = visible,
) {
  const requestedMinimum = terminalLayoutMinimum(layout);
  let temporary = layout;
  if (requestedMinimum.width > available.width || requestedMinimum.height > available.height) {
    const responsive = getResponsiveTerminalGeometry(layout, available);
    for (const divider of responsive.dividers)
      temporary = orientTerminalLayout(temporary, divider.path, divider.direction);
  }
  const minimum = temporary === layout ? requestedMinimum : terminalLayoutMinimum(temporary);
  const viewport = {
    width: Math.max(visible.width, minimum.width),
    height: Math.max(visible.height, minimum.height),
  };
  return { viewport, ...getResponsiveTerminalGeometry(temporary, viewport, false) };
}

export function terminalLayoutFits(
  layout: TerminalLayout,
  viewport: TerminalLayoutViewport,
): boolean {
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) return false;
  const surface = getTerminalLayoutSurface(layout, viewport);
  return surface.viewport.width <= viewport.width && surface.viewport.height <= viewport.height;
}
