import type { Terminal } from "@xterm/xterm";

type SelectionPoint = [number, number] | undefined;
type SelectionRequest = [start: SelectionPoint, end: SelectionPoint, columnMode: boolean];

interface RenderServiceLike {
  handleSelectionChanged?: (...request: SelectionRequest) => void;
}

// xterm's DOM renderer rebuilds every row on a selection refresh, even in a hidden terminal,
// where a `display: none` pane measures every character as zero wide and forces a layout.
export function deferHiddenSelectionRepaint(
  terminal: Terminal,
  isVisible: () => boolean,
): { flush: () => void } {
  const service = (terminal as unknown as { _core?: { _renderService?: RenderServiceLike } })._core
    ?._renderService;
  const repaint = service?.handleSelectionChanged;
  if (!service || typeof repaint !== "function") return { flush: () => undefined };

  let held: SelectionRequest | null = null;
  service.handleSelectionChanged = (...request) => {
    if (isVisible()) {
      held = null;
      repaint.apply(service, request);
    } else held = request;
  };
  return {
    flush() {
      const request = held;
      held = null;
      if (request) repaint.apply(service, request);
    },
  };
}
