import { useMemo, useRef } from "react";

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
