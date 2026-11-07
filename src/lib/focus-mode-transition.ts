import { flushSync } from "react-dom";

let generation = 0;
let animations: Animation[] = [];
let overlays: HTMLElement[] = [];
let restoreWorkspace: (() => void) | null = null;

/** Update controls immediately, then move the live workspace without capturing terminal frames. */
export function transitionFocusMode(direction: "enter" | "exit", update: () => void) {
  const token = ++generation;
  const root = document.documentElement;
  const workspace = document.querySelector<HTMLElement>(".workspace-shell");
  // Measure the visible position before cancelling an interrupted slide.
  const before = workspace?.getBoundingClientRect();
  animations.forEach((animation) => animation.cancel());
  restoreWorkspace?.();
  restoreWorkspace = null;
  overlays.forEach((overlay) => overlay.remove());
  animations = [];
  overlays = [];
  const supported = typeof HTMLElement.prototype.animate === "function";
  const sidebar =
    direction === "enter" && supported ? document.querySelector<HTMLElement>(".sidebar") : null;
  const bounds = sidebar?.getBoundingClientRect();
  const departing = sidebar?.cloneNode(true) as HTMLElement | undefined;

  // No capture callback or animation frame may delay the real controls/state.
  flushSync(update);
  delete root.dataset.focusTransition;
  if (!supported || !workspace || !before) return;
  root.dataset.focusTransition = direction;
  const styles = getComputedStyle(root);
  // Production CSS can shorten 180ms to .18s. WAAPI always takes milliseconds.
  const duration = /^(\d*\.?\d+)(ms|s)$/.exec(styles.getPropertyValue("--motion-focus").trim());
  const options = {
    duration: duration ? Number(duration[1]) * (duration[2] === "s" ? 1000 : 1) : 180,
    easing: styles.getPropertyValue("--ease").trim() || "ease-out",
    fill: "both" as const,
  };
  const animate = (node: HTMLElement, frames: Keyframe[]) =>
    animations.push(node.animate(frames, options));
  const after = workspace.getBoundingClientRect();
  // Interpolate the real layout box, never scale a bitmap of terminal glyphs.
  // Fix it to the viewport only for this transition; the grid already owns the
  // destination, and ResizeObserver keeps the live terminal fitted as it grows.
  const position = workspace.style.position;
  const zIndex = workspace.style.zIndex;
  workspace.style.position = "fixed";
  workspace.style.zIndex = "7";
  restoreWorkspace = () => {
    workspace.style.position = position;
    workspace.style.zIndex = zIndex;
  };
  const frame = (box: DOMRect): Keyframe => ({
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  });
  animate(workspace, [frame(before), frame(after)]);
  if (departing && bounds) {
    departing.inert = true;
    departing.setAttribute("aria-hidden", "true");
    departing.removeAttribute("id");
    departing.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    Object.assign(departing.style, {
      position: "fixed",
      display: "flex",
      top: bounds.top + "px",
      left: bounds.left + "px",
      width: bounds.width + "px",
      height: bounds.height + "px",
      pointerEvents: "none",
      zIndex: "6",
    });
    departing.classList.add("focus-departing-sidebar");
    document.querySelector(".app-shell")?.append(departing);
    overlays.push(departing);
    animate(departing, [
      { opacity: 1, transform: "translateX(0)" },
      { opacity: 0, transform: "translateX(-12px)" },
    ]);
  } else if (direction === "exit") {
    const arriving = document.querySelector<HTMLElement>(".sidebar");
    if (arriving)
      animate(arriving, [
        { opacity: 0, transform: "translateX(-12px)" },
        { opacity: 1, transform: "translateX(0)" },
      ]);
  }
  const panes = document.querySelector<HTMLElement>(".session-pane-tabs");
  if (panes) animate(panes, [{ opacity: 0 }, { opacity: 1 }]);
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
    if (generation !== token) return;
    restoreWorkspace?.();
    restoreWorkspace = null;
    animations.forEach((animation) => animation.cancel());
    overlays.forEach((overlay) => overlay.remove());
    overlays = [];
    animations = [];
    delete root.dataset.focusTransition;
  });
}
