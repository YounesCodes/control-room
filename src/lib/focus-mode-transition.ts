import { flushSync } from "react-dom";

let generation = 0;
let animations: Animation[] = [];
let overlays: HTMLElement[] = [];

/** Update controls immediately, then move the live workspace without capturing terminal frames. */
export function transitionFocusMode(direction: "enter" | "exit", update: () => void) {
  const token = ++generation;
  const root = document.documentElement;
  const workspace = document.querySelector<HTMLElement>(".workspace-shell");
  // Measure the visible position before cancelling an interrupted slide.
  const before = workspace?.getBoundingClientRect();
  animations.forEach((animation) => animation.cancel());
  overlays.forEach((overlay) => overlay.remove());
  animations = [];
  overlays = [];
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const supported = typeof HTMLElement.prototype.animate === "function";
  const sidebar =
    direction === "enter" && !reduced && supported
      ? document.querySelector<HTMLElement>(".sidebar")
      : null;
  const bounds = sidebar?.getBoundingClientRect();
  const departing = sidebar?.cloneNode(true) as HTMLElement | undefined;

  // No capture callback or animation frame may delay the real controls/state.
  flushSync(update);
  delete root.dataset.focusTransition;
  if (reduced || !supported || !workspace || !before) return;
  root.dataset.focusTransition = direction;
  const styles = getComputedStyle(root);
  const options = {
    duration: parseFloat(styles.getPropertyValue("--motion-focus")) || 180,
    easing: styles.getPropertyValue("--ease").trim() || "ease-out",
  };
  const animate = (node: HTMLElement, frames: Keyframe[]) =>
    animations.push(node.animate(frames, options));
  const after = workspace.getBoundingClientRect();
  animate(workspace, [
    {
      transform:
        "translate(" + (before.left - after.left) + "px," + (before.top - after.top) + "px)",
    },
    { transform: "translate(0,0)" },
  ]);
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
      zIndex: "34",
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
    overlays.forEach((overlay) => overlay.remove());
    overlays = [];
    animations = [];
    delete root.dataset.focusTransition;
  });
}
