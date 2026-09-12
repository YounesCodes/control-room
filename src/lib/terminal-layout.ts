export type TerminalSplitDirection = "vertical" | "horizontal";

export type TerminalLayout = TerminalLayoutLeaf | TerminalLayoutSplit;

interface TerminalLayoutLeaf {
  kind: "leaf";
  workspaceId: string;
}

interface TerminalLayoutSplit {
  kind: "split";
  direction: TerminalSplitDirection;
  first: TerminalLayout;
  second: TerminalLayout;
}

interface TerminalPaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
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

export function selectTerminalTab(layout: TerminalLayout, workspaceId: string): TerminalLayout {
  return terminalLayoutContains(layout, workspaceId) ? layout : createTerminalLayout(workspaceId);
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
  const rectangles: Record<string, TerminalPaneRect> = {};

  function visit(
    node: TerminalLayout,
    rectangle: TerminalPaneRect,
    available: TerminalLayoutViewport,
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

    if (direction === "vertical") {
      const width = rectangle.width / 2;
      const childSpace = { ...available, width: available.width / 2 };
      visit(node.first, { ...rectangle, width }, childSpace);
      visit(node.second, { ...rectangle, left: rectangle.left + width, width }, childSpace);
      return;
    }

    const height = rectangle.height / 2;
    const childSpace = { ...available, height: available.height / 2 };
    visit(node.first, { ...rectangle, height }, childSpace);
    visit(node.second, { ...rectangle, top: rectangle.top + height, height }, childSpace);
  }

  visit(layout, { left: 0, top: 0, width: 100, height: 100 }, viewport);
  return rectangles;
}
