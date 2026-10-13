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

interface TerminalPaneRect {
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

const MIN_TERMINAL_PANE_WIDTH = 280;
const MIN_TERMINAL_PANE_HEIGHT = 180;

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
  if (!layout) return null;
  if (layout.kind === "leaf") return workspaceIds.has(layout.workspaceId) ? layout : null;
  const first = pruneTerminalLayout(layout.first, workspaceIds);
  const second = pruneTerminalLayout(layout.second, workspaceIds);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, first, second };
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
      node.direction === "vertical" && verticalRoom < 1 && horizontalRoom > verticalRoom
        ? "horizontal"
        : node.direction === "horizontal" && horizontalRoom < 1 && verticalRoom > horizontalRoom
          ? "vertical"
          : node.direction;

    const size = direction === "vertical" ? available.width : available.height;
    // Crowded layouts still allow every divider to move. Window constraints
    // affect only the displayed ratio, leaving the saved preference intact.
    const minimum = direction === "vertical" ? MIN_TERMINAL_PANE_WIDTH : MIN_TERMINAL_PANE_HEIGHT;
    const minRatio =
      Number.isFinite(size) && size > 0 ? Math.max(0.05, Math.min(minimum / size, 0.2)) : 0.05;
    const savedRatio = Number.isFinite(node.ratio) ? (node.ratio ?? 0.5) : 0.5;
    const ratio = Math.max(minRatio, Math.min(1 - minRatio, savedRatio));
    if (Number.isFinite(size) && size > 0) {
      dividers.push({
        path,
        direction,
        rectangle,
        position: size * ratio,
        size,
        min: size * minRatio,
        max: size * (1 - minRatio),
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
