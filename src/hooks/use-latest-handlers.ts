import { useMemo, useRef } from "react";

/**
 * Gives a memoized child callbacks that never change identity yet always run
 * the newest render's implementation. Call the result only from events, effects
 * and asynchronous work, never while rendering.
 */
export function useLatestHandlers<T extends Record<string, (...args: never[]) => unknown>>(
  handlers: T,
): T {
  const latest = useRef(handlers);
  latest.current = handlers;
  return useMemo(
    () =>
      Object.fromEntries(
        Object.keys(latest.current).map((name) => [
          name,
          (...args: never[]) => latest.current[name](...args),
        ]),
      ) as T,
    [],
  );
}
