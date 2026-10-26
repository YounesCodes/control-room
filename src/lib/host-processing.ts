const counts = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();

export const hostProcessing = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => snapshot,
};

function publish() {
  snapshot = new Set(counts.keys());
  listeners.forEach((listener) => listener());
}

/** Each request owns its completion, including rejection and the IPC backstop.
 * Overlapping reads must not turn the indicator off while another is pending. */
export function beginHostOperation(connectionId: unknown): () => void {
  if (typeof connectionId !== "string") return () => undefined;
  const count = counts.get(connectionId) ?? 0;
  counts.set(connectionId, count + 1);
  if (!count) publish();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const remaining = (counts.get(connectionId) ?? 1) - 1;
    if (remaining) counts.set(connectionId, remaining);
    else {
      counts.delete(connectionId);
      publish();
    }
  };
}
