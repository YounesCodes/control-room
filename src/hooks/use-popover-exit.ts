import { useEffect, useState } from "react";

/** How long an anchored popover's closing transition runs. Matches
 *  `--motion-fast`, the token the `popover-out` animation uses. */
export const POPOVER_EXIT_MS = 110;

/**
 * Keeps an anchored popover mounted for the length of its exit animation.
 *
 * Opening is synchronous: the moment `open` turns true the popover is there,
 * in the same render the caller commits. Closing borrows one beat — `closing`
 * is true while the exit animation plays, and the caller passes it down as a
 * `data-closing` attribute so the stylesheet fades the popover out and drops
 * its pointer events. Focus and dismissal happen the moment `open` goes
 * false; only the removal of the fading element waits for the animation.
 */
export function usePopoverExit(open: boolean): { present: boolean; closing: boolean } {
  const [unmounted, setUnmounted] = useState(!open);
  const present = open || !unmounted;

  useEffect(() => {
    if (open) {
      setUnmounted(false);
      return;
    }
    if (unmounted) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => setUnmounted(true), reducedMotion ? 0 : POPOVER_EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, unmounted]);

  return { present, closing: !open && present };
}
