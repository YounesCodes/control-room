export const PANEL_LIMITS = {
  connections: { min: 200, max: 480 },
  content: { min: 360, max: 1600 },
  split: { min: 240, max: 900 },
};

export type PanelSizes = Record<string, number>;

export function clampPanelSize(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}

export function restorePanelSizes(value: unknown): PanelSizes {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sizes: PanelSizes = {};
  for (const [key, size] of Object.entries(value)) {
    const limits =
      key === "connections"
        ? PANEL_LIMITS.connections
        : key.startsWith("content:")
          ? PANEL_LIMITS.content
          : key.startsWith("split:")
            ? PANEL_LIMITS.split
            : null;
    if (
      limits &&
      key.length <= 64 &&
      Object.keys(sizes).length < 32 &&
      typeof size === "number" &&
      Number.isFinite(size)
    ) {
      sizes[key] = clampPanelSize(size, limits.min, limits.max);
    }
  }
  return sizes;
}
