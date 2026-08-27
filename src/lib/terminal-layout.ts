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
  const rectangles: Record<string, TerminalPaneRect> = {};

  function visit(node: TerminalLayout, rectangle: TerminalPaneRect) {
    if (node.kind === "leaf") {
      rectangles[node.workspaceId] = rectangle;
      return;
    }

    if (node.direction === "vertical") {
      const width = rectangle.width / 2;
      visit(node.first, { ...rectangle, width });
      visit(node.second, { ...rectangle, left: rectangle.left + width, width });
      return;
    }

    const height = rectangle.height / 2;
    visit(node.first, { ...rectangle, height });
    visit(node.second, { ...rectangle, top: rectangle.top + height, height });
  }

  visit(layout, { left: 0, top: 0, width: 100, height: 100 });
  return rectangles;
}
