import type { CachedList } from "../types";

export const WORKSPACE_CACHE_TTL_MS = 30_000;

export function emptyCachedList<T>(): CachedList<T> {
  return {
    items: [],
    fetchedAt: null,
    loading: false,
    error: null,
  };
}

export function isCacheFresh(
  cache: Pick<CachedList<unknown>, "fetchedAt">,
  now = Date.now(),
): boolean {
  return cache.fetchedAt !== null && now - cache.fetchedAt < WORKSPACE_CACHE_TTL_MS;
}

export function reconcileSelection(
  items: ReadonlyArray<{ id: string }>,
  selectedId: string | null,
): string | null {
  if (selectedId && items.some((item) => item.id === selectedId)) return selectedId;
  return items[0]?.id ?? null;
}
