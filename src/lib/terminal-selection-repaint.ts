import type { Terminal } from "@xterm/xterm";

type SelectionPoint = [number, number] | undefined;
type SelectionRequest = [start: SelectionPoint, end: SelectionPoint, columnMode: boolean];

interface RenderServiceLike {
  handleSelectionChanged?: (...request: SelectionRequest) => void;
}

/**
 * Holds xterm's selection repaint while a terminal is hidden.
 *
 * xterm refreshes its selection on each scrolled frame, and its DOM renderer
 * answers by rebuilding every row. That path skips the pause xterm applies to
 * hidden terminals. Inside a `display: none` pane every character measures as
 * zero wide, is never cached, and forces a document layout on the next one, so
 * a background terminal that printed steadily stalled the view in front of it.
 * The newest request is kept and `flush` applies it once the terminal is shown,
 * which is also when xterm repaints the rows it skipped.
 *
 * A visible terminal is left exactly as xterm ships. The hook reaches a private
 * xterm service; if that service is missing or shaped differently, nothing is
 * patched.
 */
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
