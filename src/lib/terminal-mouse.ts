import type { Terminal } from "@xterm/xterm";

const DRAG_THRESHOLD = 4;
const CODEX_BANNER = /^\s*│\s*>_\s+OpenAI Codex\s+\(v\d/;

export function enableCodexDragSelection(container: HTMLElement, terminal: Terminal): () => void {
  const screen = container.querySelector(".xterm-screen");
  const document = container.ownerDocument;
  const window = document.defaultView;
  if (!screen || !window) return () => undefined;
  const mac = window.navigator.platform.startsWith("Mac");
  let codex = false;
  let pendingPress: AbortController | undefined;

  function cancelPress() {
    pendingPress?.abort();
    pendingPress = undefined;
  }

  const bufferChange = terminal.buffer.onBufferChange(() => {
    codex = false;
    cancelPress();
  });
  // Keep recognizing Codex once the welcome banner has scrolled away.
  const output = terminal.onWriteParsed(() => {
    if (terminal.modes.mouseTrackingMode === "none") {
      codex = false;
      cancelPress();
      return;
    }
    if (codex) return;
    const buffer = terminal.buffer.active;
    for (let row = 0; row < terminal.rows; row++) {
      const line = buffer.getLine(buffer.baseY + row)?.translateToString(true);
      if (line && CODEX_BANNER.test(line)) {
        codex = true;
        break;
      }
    }
  });

  // Let native xterm handle both outcomes, once we know what the gesture means.
  const holdPress = (event: MouseEvent) => {
    if (
      !codex ||
      !event.isTrusted ||
      terminal.modes.mouseTrackingMode === "none" ||
      event.button !== 0 ||
      event.buttons !== 1 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !screen.contains(event.target as Node)
    )
      return;

    event.preventDefault();
    event.stopPropagation();
    terminal.focus();
    cancelPress();
    pendingPress = new AbortController();
    const { signal } = pendingPress;

    const moved = (current: MouseEvent) =>
      Math.hypot(current.clientX - event.clientX, current.clientY - event.clientY) >=
      DRAG_THRESHOLD;
    const replayPress = (select: boolean) => {
      cancelPress();
      // xterm's selection modifier starts native selection, including its
      // handling of wrapped lines and drags that leave the terminal.
      screen.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
          button: 0,
          buttons: 1,
          detail: select ? 1 : event.detail,
          shiftKey: select && !mac,
          altKey: select && mac,
        }),
      );
    };

    document.addEventListener(
      "mousemove",
      (move) => {
        if (move.buttons !== 1) cancelPress();
        else if (moved(move)) replayPress(true);
      },
      { capture: true, signal },
    );
    document.addEventListener(
      "mouseup",
      (up) => {
        if (up.button !== 0) return;
        if (screen.contains(up.target as Node) && !moved(up)) replayPress(false);
        else cancelPress();
      },
      { capture: true, signal },
    );
    window.addEventListener("blur", cancelPress, { signal });
    document.addEventListener("pointercancel", cancelPress, { signal });
  };

  container.addEventListener("mousedown", holdPress, { capture: true });

  return () => {
    cancelPress();
    bufferChange.dispose();
    output.dispose();
    container.removeEventListener("mousedown", holdPress, { capture: true });
  };
}
