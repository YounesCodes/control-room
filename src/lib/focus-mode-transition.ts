import { flushSync } from "react-dom";

let generation = 0;
let active: ViewTransition | null = null;

/** Animate shell regions together without remounting or scaling terminal content. */
export function transitionFocusMode(direction: "enter" | "exit", update: () => void) {
  const token = ++generation;
  active?.skipTransition();
  active = null;
  const root = document.documentElement;
  if (
    !document.startViewTransition ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    delete root.dataset.focusTransition;
    update();
    return;
  }
  root.dataset.focusTransition = direction;
  const transition = document.startViewTransition(() => {
    if (token === generation) flushSync(update);
  });
  active = transition;
  // Skipped/superseded captures reject ready; the final state still applies.
  void transition.ready.catch(() => {});
  void transition.updateCallbackDone.catch(() => {});
  void transition.finished
    .catch(() => {})
    .finally(() => {
      if (token !== generation) return;
      active = null;
      delete root.dataset.focusTransition;
    });
}
