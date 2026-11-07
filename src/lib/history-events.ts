const HISTORY_CHANGED = "control-room:history-changed";

export function notifyHistoryChanged(connectionId: string) {
  window.dispatchEvent(new CustomEvent(HISTORY_CHANGED, { detail: connectionId }));
}

export function onHistoryChanged(connectionId: string, refresh: () => void) {
  const listener = (event: Event) => {
    if ((event as CustomEvent<string>).detail === connectionId) refresh();
  };
  window.addEventListener(HISTORY_CHANGED, listener);
  return () => window.removeEventListener(HISTORY_CHANGED, listener);
}
