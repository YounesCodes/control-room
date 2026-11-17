export function nextFrameOrTimeout(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      window.cancelAnimationFrame(frame);
      resolve();
    }, timeoutMs);
    const frame = window.requestAnimationFrame(() => {
      window.clearTimeout(timeout);
      resolve();
    });
  });
}

export async function finiteAnimationsSettled(element: Element): Promise<void> {
  if (typeof element.getAnimations !== "function") return;
  const finite = element
    .getAnimations({ subtree: true })
    .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime));
  await Promise.allSettled(finite.map((animation) => animation.finished));
}
