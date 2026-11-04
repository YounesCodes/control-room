export type GraphDirection = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";
export function isGraphDirection(key: string): key is GraphDirection {
  return ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key);
}

/** Choose by canvas centers, independent of DOM order and camera movement. */
export function spatialGraphNeighbor(
  direction: GraphDirection,
  currentId: string | null,
  nodes: { id: string; x: number; y: number }[],
): string | null {
  const current = nodes.find((node) => node.id === currentId);
  if (!current) return null;
  const horizontal = direction === "ArrowLeft" || direction === "ArrowRight";
  const sign = direction === "ArrowLeft" || direction === "ArrowUp" ? -1 : 1;
  let best: { id: string; score: number } | null = null;
  for (const node of nodes) {
    if (node.id === currentId) continue;
    const dx = node.x - current.x,
      dy = node.y - current.y;
    const forward = (horizontal ? dx : dy) * sign;
    if (forward <= 1) continue;
    const sideways = Math.abs(horizontal ? dy : dx);
    const score = Math.hypot(forward, sideways) + sideways * 2;
    if (!best || score < best.score || (score === best.score && node.id < best.id))
      best = { id: node.id, score };
  }
  return best?.id ?? null;
}
