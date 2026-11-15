import axe from "axe-core";

function runningFiniteAnimations() {
  return document
    .getAnimations()
    .filter(
      (animation) =>
        animation.playState === "running" &&
        animation.effect?.getComputedTiming().endTime !== Infinity,
    );
}

/**
 * Waits until no finite animation or transition is running in the document.
 * Axe samples computed colors, so an element that is still fading in reports
 * a blended, lower-contrast color than the one it settles on.
 */
export async function waitForSettledMotion() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // Let pending style changes start their transitions before sampling.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const animations = runningFiniteAnimations();
    if (animations.length === 0) return;
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  }
  throw new Error("Animations kept restarting; the UI never settled before the axe run");
}

/** `axe.run` after every finite animation and transition has finished. */
export async function runAxe(context: axe.ElementContext, options: axe.RunOptions = {}) {
  await waitForSettledMotion();
  return axe.run(context, options);
}
